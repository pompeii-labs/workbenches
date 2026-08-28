import type { RunnerInvocation } from '../../types.js';

export interface SpawnedOpenCodeServer {
    exited: Promise<number>;
    stdout?: ReadableStream<Uint8Array>;
    stderr?: ReadableStream<Uint8Array>;
    kill(): void;
}

export type OpenCodeFetch = (
    input: string | URL | Request,
    init?: RequestInit
) => Promise<Response>;

export interface OpenCodeServerOptions {
    workspaceDirectory: string;
    spawn: (
        command: string[],
        options: {
            cwd: string;
            env: Record<string, string | undefined>;
            stdin: 'ignore';
            stdout: 'pipe';
            stderr: 'pipe';
        }
    ) => SpawnedOpenCodeServer;
    fetch: OpenCodeFetch;
    password: () => string;
    startupTimeoutMs: number;
}

export class OpenCodeServer {
    private readonly abort = new AbortController();
    private readonly options: OpenCodeServerOptions;
    private child: SpawnedOpenCodeServer | undefined;
    private url: string | undefined;
    private password: string | undefined;
    private eventLoop: Promise<void> | undefined;
    private stdoutLoop: Promise<void> | undefined;
    private stderrLoop: Promise<string> | undefined;
    private closed = false;

    constructor(options: OpenCodeServerOptions) {
        this.options = options;
    }

    async start(
        buildInvocation: (password: string) => RunnerInvocation,
        onFailure: (error: Error) => void
    ): Promise<void> {
        const password = this.options.password();
        if (!password) throw new Error('OpenCode server password must not be empty');
        this.password = password;
        const invocation = buildInvocation(password);

        const child = this.options.spawn(invocation.command, {
            cwd: invocation.cwd,
            env: invocation.env,
            stdin: 'ignore',
            stdout: 'pipe',
            stderr: 'pipe',
        });
        this.child = child;
        this.stderrLoop = readLimitedText(child.stderr, 64 * 1024);
        const ready = deferred<string>();
        this.stdoutLoop = consumeLines(child.stdout, async (line) => {
            const url = line.match(/https?:\/\/127\.0\.0\.1:\d+/)?.[0];
            if (url) ready.resolve(url);
        });
        const timeout = setTimeout(
            () =>
                ready.reject(new Error('OpenCode server did not become ready in time')),
            this.options.startupTimeoutMs
        );
        void child.exited.then((code) => {
            if (!this.closed && !this.url) {
                ready.reject(new Error(`OpenCode server exited with code ${code}`));
            } else if (!this.closed) {
                onFailure(new Error(`OpenCode server exited with code ${code}`));
            }
        });
        try {
            this.url = await ready.promise;
        } finally {
            clearTimeout(timeout);
        }
    }

    async subscribe(
        consume: (value: unknown) => Promise<void>,
        onFailure: (error: Error) => void
    ): Promise<void> {
        const response = await this.authFetch(this.endpoint('/event'), {
            signal: this.abort.signal,
        });
        if (!response.ok || !response.body) {
            throw new Error(
                `OpenCode event stream failed with HTTP ${response.status}`
            );
        }
        this.eventLoop = consumeSse(response.body, consume).catch((error) => {
            if (!this.closed && !isAbortError(error)) {
                onFailure(new Error('OpenCode event stream failed', { cause: error }));
            }
        });
    }

    async request(path: string, init: RequestInit): Promise<Response> {
        const response = await this.authFetch(this.endpoint(path), init);
        if (!response.ok) {
            throw new Error(`OpenCode request failed with HTTP ${response.status}`);
        }
        return response;
    }

    async requestJson(path: string, init: RequestInit): Promise<unknown> {
        const response = await this.request(path, init);
        return response.json();
    }

    async replyPermission(path: string, body: unknown): Promise<boolean> {
        const response = await this.authFetch(this.endpoint(path), {
            method: 'POST',
            body: JSON.stringify(body),
        });
        if (response.status === 404) return false;
        if (!response.ok) {
            throw new Error(
                `OpenCode permission reply failed with HTTP ${response.status}`
            );
        }
        return true;
    }

    async close(): Promise<void> {
        if (this.closed) return;
        this.closed = true;
        this.abort.abort();
        this.child?.kill();
        await Promise.allSettled([
            this.eventLoop,
            this.stdoutLoop,
            this.stderrLoop,
            this.child?.exited,
        ]);
    }

    private endpoint(path: string): URL {
        if (!this.url) throw new Error('OpenCode server is not ready');
        const url = new URL(path, this.url);
        url.searchParams.set('directory', this.options.workspaceDirectory);
        return url;
    }

    private authFetch(input: string | URL | Request, init: RequestInit = {}) {
        if (!this.password) throw new Error('OpenCode server is not ready');
        const headers = new Headers(init.headers);
        headers.set('Authorization', `Basic ${btoa(`opencode:${this.password}`)}`);
        if (init.body) headers.set('Content-Type', 'application/json');
        return this.options.fetch(input, { ...init, headers });
    }
}

export function spawnOpenCodeServer(
    command: string[],
    options: {
        cwd: string;
        env: Record<string, string | undefined>;
        stdin: 'ignore';
        stdout: 'pipe';
        stderr: 'pipe';
    }
): SpawnedOpenCodeServer {
    return Bun.spawn(command, options);
}

async function consumeLines(
    stream: ReadableStream<Uint8Array> | undefined,
    consume: (line: string) => Promise<void>
): Promise<void> {
    if (!stream) return;
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    for (;;) {
        const next = await reader.read();
        if (next.done) break;
        pending += decoder.decode(next.value, { stream: true });
        const lines = pending.split('\n');
        pending = lines.pop() ?? '';
        for (const line of lines) if (line.trim()) await consume(line);
    }
    pending += decoder.decode();
    if (pending.trim()) await consume(pending);
}

async function consumeSse(
    stream: ReadableStream<Uint8Array>,
    consume: (value: unknown) => Promise<void>
) {
    let data = '';
    await consumeLines(stream, async (line) => {
        if (!line.startsWith('data:')) return;
        data += line.slice(5).trimStart();
        if (!data) return;
        try {
            await consume(JSON.parse(data));
            data = '';
        } catch (error) {
            if (!(error instanceof SyntaxError)) throw error;
        }
    });
}

async function readLimitedText(
    stream: ReadableStream<Uint8Array> | undefined,
    limit: number
): Promise<string> {
    if (!stream) return '';
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let output = '';
    for (;;) {
        const next = await reader.read();
        if (next.done) break;
        if (output.length < limit) output += decoder.decode(next.value);
    }
    return output.slice(0, limit);
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((accepted, rejected) => {
        resolve = accepted;
        reject = rejected;
    });
    return { promise, resolve, reject };
}

function isAbortError(error: unknown) {
    return error instanceof Error && error.name === 'AbortError';
}
