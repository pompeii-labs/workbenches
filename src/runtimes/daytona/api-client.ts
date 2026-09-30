import { WORKBENCH_USER_AGENT } from '../../user-agent.js';
import type { RuntimeCommandResult } from '../contracts.js';
import { quote } from '../e2b/shell.js';
import type {
    DaytonaClient,
    DaytonaCreateOptions,
    DaytonaProcess,
    DaytonaProcessOptions,
    DaytonaRunOptions,
    DaytonaSandbox,
    DaytonaSandboxInfo,
    DaytonaSandboxSummary,
} from './contracts.js';

export const defaultDaytonaApiUrl = 'https://app.daytona.io/api';

export interface DaytonaApiOptions {
    apiKey: string;
    /** Defaults to the public Daytona API. */
    apiUrl?: string;
    fetch?: typeof fetch;
    /** Bound on sandbox management calls. Default 30 seconds. */
    requestTimeoutMs?: number;
    /** Bound on one command run to completion. Default 60 minutes. */
    commandTimeoutMs?: number;
    /** Bound on one file transfer. Default 30 minutes. */
    transferTimeoutMs?: number;
    /** How long a new sandbox may take to start. Default 10 minutes. */
    startTimeoutMs?: number;
    /** Delay between polls of a background command. Default 300 milliseconds. */
    pollIntervalMs?: number;
}

export class DaytonaApiError extends Error {
    constructor(
        message: string,
        readonly status?: number
    ) {
        super(message);
        this.name = 'DaytonaApiError';
    }
}

/**
 * Daytona over its REST API, with `fetch` and nothing else.
 *
 * Sandbox management calls (create, list, delete, preview URLs) use the documented
 * OpenAPI surface at `DAYTONA_API_URL`. Commands and files go to the sandbox's
 * toolbox, reached at `<toolboxProxyUrl>/<sandboxId>` with the same credential.
 * Every toolbox path and payload lives in `ToolboxSandbox` below, so that is the
 * one place to adjust if Daytona revises it.
 */
export class DaytonaApiClient implements DaytonaClient {
    private readonly transport: Transport;

    constructor(options: DaytonaApiOptions) {
        if (!options.apiKey.trim()) throw new Error('A Daytona API key is required');
        this.transport = new Transport(options);
    }

    async createSandbox(options: DaytonaCreateOptions): Promise<DaytonaSandbox> {
        const body = {
            buildInfo: { dockerfileContent: `FROM ${imageReference(options.image)}` },
            labels: options.labels,
            ...(options.env && Object.keys(options.env).length > 0
                ? { env: options.env }
                : {}),
            ...(options.resources?.cpu ? { cpu: options.resources.cpu } : {}),
            ...(options.resources?.memoryGb
                ? { memory: options.resources.memoryGb }
                : {}),
            ...(options.resources?.diskGb ? { disk: options.resources.diskGb } : {}),
            // A run owns its sandbox until cleanup, so idle auto-stop is off. The
            // lease below is the safety net if this process dies.
            autoStopInterval: 0,
            ttlMinutes: options.leaseMinutes,
        };
        const created = await this.transport.json<SandboxDto>('POST', '/sandbox', {
            json: body,
        });
        try {
            const ready = await this.transport.waitUntilStarted(created.id);
            return new ToolboxSandbox(
                this.transport,
                ready.id,
                await this.transport.toolboxUrl(ready)
            );
        } catch (error) {
            // Never leave a sandbox behind that the caller never received.
            await this.deleteSandbox(created.id).catch(() => {});
            throw error;
        }
    }

    async listSandboxes(
        labels: Record<string, string>
    ): Promise<DaytonaSandboxSummary[]> {
        const result: DaytonaSandboxSummary[] = [];
        let cursor: string | undefined;
        do {
            const page = await this.transport.json<{
                items?: SandboxDto[];
                nextCursor?: string | null;
            }>('GET', '/sandbox', {
                query: {
                    labels: JSON.stringify(labels),
                    limit: '200',
                    ...(cursor ? { cursor } : {}),
                },
            });
            for (const item of page.items ?? []) {
                result.push({
                    id: item.id,
                    labels: item.labels ?? {},
                    state: item.state ?? 'unknown',
                });
            }
            cursor = page.nextCursor ?? undefined;
        } while (cursor);
        return result;
    }

    async getSandbox(id: string): Promise<DaytonaSandbox | undefined> {
        const dto = await this.transport
            .json<SandboxDto>('GET', `/sandbox/${encodeURIComponent(id)}`)
            .catch((error) => {
                if (error instanceof DaytonaApiError && error.status === 404) {
                    return undefined;
                }
                throw error;
            });
        if (!dto) return undefined;
        return new ToolboxSandbox(
            this.transport,
            dto.id,
            await this.transport.toolboxUrl(dto),
            dto.state
        );
    }

    async deleteSandbox(id: string): Promise<void> {
        try {
            await this.transport.request(
                'DELETE',
                `/sandbox/${encodeURIComponent(id)}`
            );
        } catch (error) {
            // Already gone is the state the caller wanted.
            if (error instanceof DaytonaApiError && error.status === 404) return;
            throw error;
        }
    }
}

interface SandboxDto {
    id: string;
    state?: string;
    labels?: Record<string, string>;
    errorReason?: string;
    toolboxProxyUrl?: string;
    cpu?: number;
    memory?: number;
    disk?: number;
    createdAt?: string;
}

interface RequestInitLike {
    json?: unknown;
    query?: Record<string, string>;
    body?: FormData;
    accept?: string;
    timeoutMs?: number;
    /** An absolute URL, for toolbox calls. Otherwise the path is under the API URL. */
    absolute?: boolean;
}

/** Authenticated, bounded HTTP. Holds the credential; never logs or echoes it. */
class Transport {
    readonly apiUrl: string;
    readonly requestTimeoutMs: number;
    readonly commandTimeoutMs: number;
    readonly transferTimeoutMs: number;
    readonly startTimeoutMs: number;
    readonly pollIntervalMs: number;
    private readonly fetcher: typeof fetch;
    private readonly apiKey: string;

    constructor(options: DaytonaApiOptions) {
        this.apiKey = options.apiKey.trim();
        this.apiUrl = (options.apiUrl?.trim() || defaultDaytonaApiUrl).replace(
            /\/+$/,
            ''
        );
        this.fetcher = options.fetch ?? globalThis.fetch;
        this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
        this.commandTimeoutMs = options.commandTimeoutMs ?? 60 * 60_000;
        this.transferTimeoutMs = options.transferTimeoutMs ?? 30 * 60_000;
        this.startTimeoutMs = options.startTimeoutMs ?? 10 * 60_000;
        this.pollIntervalMs = options.pollIntervalMs ?? 300;
    }

    async request(
        method: string,
        path: string,
        init: RequestInitLike = {}
    ): Promise<Response> {
        const url = new URL(init.absolute ? path : `${this.apiUrl}${path}`);
        for (const [name, value] of Object.entries(init.query ?? {})) {
            url.searchParams.set(name, value);
        }
        const headers: Record<string, string> = {
            Authorization: `Bearer ${this.apiKey}`,
            'User-Agent': WORKBENCH_USER_AGENT,
            Accept: init.accept ?? 'application/json',
        };
        if (init.json !== undefined) headers['Content-Type'] = 'application/json';
        const response = await this.fetcher(url, {
            method,
            headers,
            ...(init.json !== undefined
                ? { body: JSON.stringify(init.json) }
                : init.body
                  ? { body: init.body }
                  : {}),
            signal: AbortSignal.timeout(init.timeoutMs ?? this.requestTimeoutMs),
        });
        if (!response.ok) {
            const detail = (await response.text().catch(() => '')).slice(0, 500);
            throw new DaytonaApiError(
                `Daytona API ${method} ${url.pathname} failed with ${response.status}${detail ? `: ${detail}` : ''}`,
                response.status
            );
        }
        return response;
    }

    async json<T>(
        method: string,
        path: string,
        init: RequestInitLike = {}
    ): Promise<T> {
        const response = await this.request(method, path, init);
        return (await response.json()) as T;
    }

    async waitUntilStarted(id: string): Promise<SandboxDto> {
        const deadline = Date.now() + this.startTimeoutMs;
        for (;;) {
            const dto = await this.json<SandboxDto>(
                'GET',
                `/sandbox/${encodeURIComponent(id)}`
            );
            if (dto.state === 'started') return dto;
            if (
                dto.state === 'error' ||
                dto.state === 'build_failed' ||
                dto.state === 'destroyed' ||
                dto.state === 'destroying'
            ) {
                throw new DaytonaApiError(
                    `Daytona sandbox ${id} entered state ${dto.state}${dto.errorReason ? `: ${dto.errorReason}` : ''}`
                );
            }
            if (Date.now() >= deadline) {
                throw new DaytonaApiError(
                    `Daytona sandbox ${id} did not start within ${Math.round(this.startTimeoutMs / 1000)} seconds (state: ${dto.state ?? 'unknown'})`
                );
            }
            await sleep(Math.min(1_000, this.pollIntervalMs * 3));
        }
    }

    async toolboxUrl(dto: SandboxDto): Promise<string> {
        const proxy =
            dto.toolboxProxyUrl ??
            (
                await this.json<{ url: string }>(
                    'GET',
                    `/sandbox/${encodeURIComponent(dto.id)}/toolbox-proxy-url`
                )
            ).url;
        return `${proxy.replace(/\/+$/, '')}/${encodeURIComponent(dto.id)}`;
    }
}

/** Commands, files, and preview URLs for one sandbox. */
class ToolboxSandbox implements DaytonaSandbox {
    constructor(
        private readonly transport: Transport,
        readonly id: string,
        private readonly toolbox: string,
        readonly state?: string
    ) {}

    async run(
        command: string,
        options: DaytonaRunOptions = {}
    ): Promise<RuntimeCommandResult> {
        const response = await this.transport.json<{
            exitCode?: number;
            code?: number;
            result?: string;
        }>('POST', `${this.toolbox}/process/execute`, {
            absolute: true,
            timeoutMs: this.transport.commandTimeoutMs,
            json: {
                // The toolbox returns one merged stream, so fold stderr in
                // explicitly and keep failure detail in the result.
                command: `{\n${asRoot(command, options.user)}\n} 2>&1`,
                ...(options.cwd ? { cwd: options.cwd } : {}),
                ...(options.env ? { envs: options.env } : {}),
                timeout: Math.ceil(this.transport.commandTimeoutMs / 1000),
            },
        });
        return {
            code: response.exitCode ?? response.code ?? 0,
            stdout: response.result ?? '',
            stderr: '',
        };
    }

    async start(
        command: string,
        options: DaytonaProcessOptions = {}
    ): Promise<DaytonaProcess> {
        const session = `wb-${crypto.randomUUID()}`;
        await this.transport.request('POST', `${this.toolbox}/process/session`, {
            absolute: true,
            json: { sessionId: session },
        });
        try {
            const started = await this.transport.json<{ cmdId: string }>(
                'POST',
                `${this.toolbox}/process/session/${session}/exec`,
                {
                    absolute: true,
                    json: {
                        command: subshell(command, options),
                        runAsync: true,
                        suppressInputEcho: true,
                    },
                }
            );
            return new SessionProcess(
                this.transport,
                `${this.toolbox}/process/session/${session}`,
                started.cmdId,
                options
            );
        } catch (error) {
            await this.endSession(session);
            throw error;
        }
    }

    async upload(path: string, data: Uint8Array): Promise<void> {
        const form = new FormData();
        form.append('files[0].path', path);
        form.append(
            'files[0].file',
            new Blob([data as Uint8Array<ArrayBuffer>]),
            path.split('/').at(-1) ?? 'file'
        );
        await this.transport.request('POST', `${this.toolbox}/files/bulk-upload`, {
            absolute: true,
            body: form,
            timeoutMs: this.transport.transferTimeoutMs,
        });
    }

    async download(path: string): Promise<ReadableStream<Uint8Array>> {
        const response = await this.transport.request(
            'GET',
            `${this.toolbox}/files/download`,
            {
                absolute: true,
                query: { path },
                accept: 'application/octet-stream',
                timeoutMs: this.transport.transferTimeoutMs,
            }
        );
        if (!response.body) throw new DaytonaApiError(`Empty download: ${path}`);
        return response.body;
    }

    async previewUrl(port: number, ttlSeconds: number): Promise<string> {
        const preview = await this.transport.json<{ url: string }>(
            'GET',
            `/sandbox/${encodeURIComponent(this.id)}/ports/${port}/signed-preview-url`,
            { query: { expiresInSeconds: String(Math.max(60, Math.ceil(ttlSeconds))) } }
        );
        return preview.url;
    }

    async info(): Promise<DaytonaSandboxInfo> {
        const dto = await this.transport.json<SandboxDto>(
            'GET',
            `/sandbox/${encodeURIComponent(this.id)}`
        );
        const createdAt = dto.createdAt ? new Date(dto.createdAt) : undefined;
        return {
            cpuCount: dto.cpu ?? 0,
            memoryMB: (dto.memory ?? 0) * 1024,
            diskGb: dto.disk ?? 0,
            ...(createdAt && Number.isFinite(createdAt.getTime()) ? { createdAt } : {}),
        };
    }

    private async endSession(session: string): Promise<void> {
        await this.transport
            .request('DELETE', `${this.toolbox}/process/session/${session}`, {
                absolute: true,
            })
            .catch(() => {});
    }
}

const maximumPollFailures = 5;

/**
 * A command running in a toolbox session. Output is read by polling the
 * session's logs and appending only what is new, so a dropped poll loses nothing.
 */
class SessionProcess implements DaytonaProcess {
    private readonly finished: Promise<RuntimeCommandResult>;
    private stopped = false;

    constructor(
        private readonly transport: Transport,
        private readonly session: string,
        private readonly command: string,
        private readonly options: DaytonaProcessOptions
    ) {
        this.finished = this.follow();
    }

    wait(): Promise<RuntimeCommandResult> {
        return this.finished;
    }

    async sendStdin(data: string | Uint8Array): Promise<void> {
        await this.transport.request(
            'POST',
            `${this.session}/command/${this.command}/input`,
            {
                absolute: true,
                json: {
                    data:
                        typeof data === 'string'
                            ? data
                            : new TextDecoder().decode(data),
                },
            }
        );
    }

    async closeStdin(): Promise<void> {
        // The toolbox has no end-of-input operation. Runners that need EOF to
        // finish should be launched without piped stdin on this runtime.
    }

    async kill(): Promise<void> {
        this.stopped = true;
        await this.transport
            .request('DELETE', this.session, { absolute: true })
            .catch(() => {});
    }

    private async follow(): Promise<RuntimeCommandResult> {
        let stdout = '';
        let stderr = '';
        const drain = async () => {
            const logs = await this.logs();
            if (logs.stdout.length > stdout.length) {
                const added = logs.stdout.slice(stdout.length);
                stdout = logs.stdout;
                await this.options.onStdout?.(added);
            }
            if (logs.stderr.length > stderr.length) {
                const added = logs.stderr.slice(stderr.length);
                stderr = logs.stderr;
                await this.options.onStderr?.(added);
            }
        };
        let failures = 0;
        for (;;) {
            if (this.stopped) {
                await drain().catch(() => {});
                return { code: 143, stdout, stderr };
            }
            let status: { exitCode?: number | null };
            try {
                status = await this.transport.json<{ exitCode?: number | null }>(
                    'GET',
                    `${this.session}/command/${this.command}`,
                    { absolute: true }
                );
                await drain();
                failures = 0;
            } catch (error) {
                // A brief network or proxy failure must not end a long run.
                if (++failures >= maximumPollFailures) throw error;
                await sleep(this.transport.pollIntervalMs * failures);
                continue;
            }
            if (status.exitCode !== undefined && status.exitCode !== null) {
                // One more read so output written just before exit is not lost.
                await drain();
                await this.transport
                    .request('DELETE', this.session, { absolute: true })
                    .catch(() => {});
                return { code: status.exitCode, stdout, stderr };
            }
            await sleep(this.transport.pollIntervalMs);
        }
    }

    private async logs(): Promise<{ stdout: string; stderr: string }> {
        const response = await this.transport.request(
            'GET',
            `${this.session}/command/${this.command}/logs`,
            { absolute: true, accept: 'application/json,text/plain' }
        );
        const text = await response.text();
        if (!(response.headers.get('content-type') ?? '').includes('json')) {
            return { stdout: text, stderr: '' };
        }
        const body = JSON.parse(text) as {
            stdout?: string;
            stderr?: string;
            output?: string;
        };
        return {
            stdout:
                body.stdout ?? (body.stderr === undefined ? (body.output ?? '') : ''),
            stderr: body.stderr ?? '',
        };
    }
}

/** Runs the command as root, through sudo when the sandbox user is not root. */
function asRoot(command: string, user: 'root' | undefined): string {
    if (user !== 'root') return command;
    return [
        'if [ "$(id -u)" = 0 ]; then S=; elif command -v sudo >/dev/null 2>&1; then S="sudo -n"; else echo "root access is required" >&2; exit 1; fi',
        `$S sh -c ${quote(command)}`,
    ].join('\n');
}

/** A subshell that applies the environment and directory, then runs `command`. */
function subshell(command: string, options: DaytonaProcessOptions): string {
    const exports = Object.entries(options.env ?? {}).map(
        ([name, value]) => `export ${assertName(name)}=${quote(value)}`
    );
    return `(${[
        ...exports,
        ...(options.cwd ? [`cd ${quote(options.cwd)}`] : []),
        command,
    ].join(' && ')})`;
}

function assertName(name: string): string {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        throw new Error(`Invalid environment variable name: ${name}`);
    }
    return name;
}

function imageReference(image: string): string {
    if (!image.trim() || /[\s\0]/.test(image)) {
        throw new Error(`Invalid Daytona image reference: ${JSON.stringify(image)}`);
    }
    return image.trim();
}

function sleep(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
