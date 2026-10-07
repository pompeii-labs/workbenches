import type { RuntimeCommandResult } from '../contracts.js';
import { RuntimeError } from '../error.js';
import type { RemoteCommand, RemoteCommandOptions } from '../remote/process.js';
import type { RemoteRunOptions } from '../remote/runtime.js';
import { quote } from '../staging/shell.js';
import type { DaytonaSandbox, DaytonaSandboxInfo } from './contracts.js';
import { SessionProcess } from './process.js';
import {
    DaytonaApiError,
    type DaytonaTransport,
    type SandboxDto,
} from './transport.js';

/** Commands, files, and preview URLs for one sandbox. */
export class DaytonaToolbox implements DaytonaSandbox {
    constructor(
        private readonly transport: DaytonaTransport,
        readonly id: string,
        private readonly toolbox: string,
        readonly state?: string
    ) {}

    async run(
        command: string,
        options: RemoteRunOptions = {}
    ): Promise<RuntimeCommandResult> {
        const timeoutMilliseconds =
            options.timeoutMilliseconds ?? this.transport.commandTimeoutMs;
        const reply = await this.transport.request(
            'POST',
            `${this.toolbox}/process/execute`,
            {
                absolute: true,
                timeoutMs: timeoutMilliseconds,
                json: {
                    // The toolbox returns one merged stream, so fold stderr in
                    // explicitly and keep failure detail in the result.
                    command: `{\n${this.asRoot(command, options.user)}\n} 2>&1`,
                    ...(options.cwd ? { cwd: options.cwd } : {}),
                    ...(options.env ? { envs: options.env } : {}),
                    timeout: Math.ceil(timeoutMilliseconds / 1000),
                },
            }
        );
        const response = this.executeReply(await reply.text());
        return { code: response.code, stdout: response.result ?? '', stderr: '' };
    }

    async start(
        command: string,
        options: RemoteCommandOptions = {}
    ): Promise<RemoteCommand> {
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
                        command: this.subshell(command, options),
                        runAsync: true,
                        suppressInputEcho: true,
                        ...(options.env ? { envs: options.env } : {}),
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

    /** The toolbox reports no file sizes, so ask the sandbox's own shell. */
    async fileSize(path: string): Promise<number> {
        const result = await this.run(`wc -c < ${quote(path)}`);
        const size = Number(result.stdout.trim().split(/\s+/).at(-1));
        if (result.code !== 0 || !Number.isSafeInteger(size) || size < 0) {
            throw new RuntimeError(
                'daytona',
                'collect',
                `Cannot read the size of ${path} in the sandbox`
            );
        }
        return size;
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

    /**
     * Reads the reply to a command. A reply without a numeric exit code is not a
     * success: a proxy page or an empty body must never pass as a command that ran.
     */
    private executeReply(text: string): { code: number; result?: string } {
        let body: unknown;
        try {
            body = JSON.parse(text);
        } catch {
            body = undefined;
        }
        const reply = (typeof body === 'object' && body !== null ? body : {}) as {
            exitCode?: unknown;
            code?: unknown;
            result?: unknown;
        };
        const code = reply.exitCode ?? reply.code;
        if (typeof code !== 'number' || !Number.isInteger(code)) {
            throw new DaytonaApiError(
                'Daytona toolbox process/execute returned an unexpected response: expected JSON with a numeric exitCode'
            );
        }
        return {
            code,
            ...(typeof reply.result === 'string' ? { result: reply.result } : {}),
        };
    }

    /** Runs the command as root, through sudo when the sandbox user is not root. */
    private asRoot(command: string, user: 'root' | undefined): string {
        if (user !== 'root') return command;
        return [
            'if [ "$(id -u)" = 0 ]; then S=; elif command -v sudo >/dev/null 2>&1; then S="sudo -n"; else echo "root access is required" >&2; exit 1; fi',
            `$S sh -c ${quote(command)}`,
        ].join('\n');
    }

    /** A subshell that applies the directory, then runs `command`. */
    private subshell(command: string, options: RemoteCommandOptions): string {
        for (const name of Object.keys(options.env ?? {})) {
            if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
                throw new RuntimeError(
                    'daytona',
                    'launch',
                    `Invalid environment variable name: ${name}`
                );
            }
        }
        return `(${[...(options.cwd ? [`cd ${quote(options.cwd)}`] : []), command].join(
            ' && '
        )})`;
    }
}
