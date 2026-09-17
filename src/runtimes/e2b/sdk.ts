import {
    CommandExitError,
    type CommandHandle,
    type CommandResult,
    E2B,
    type Sandbox as E2BSdkSandbox,
} from 'e2b';

import type {
    E2BClient,
    E2BCommand,
    E2BCommandOptions,
    E2BManagedSandbox,
    E2BPreparedTemplate,
    E2BPty,
    E2BPtyOptions,
    E2BRunOptions,
    E2BSandbox,
    E2BSandboxInfo,
    E2BTemplateSource,
} from './contracts.js';

export const managedMetadata = 'dev.workbenches.managed';
export const runMetadata = 'dev.workbenches.run';
export const scopeMetadata = 'dev.workbenches.scope';

export class E2BSdkClient implements E2BClient {
    readonly #client: E2B;

    constructor(apiKey: string) {
        this.#client = new E2B({ apiKey });
    }

    async prepareTemplate(
        source: E2BTemplateSource,
        name: string
    ): Promise<E2BPreparedTemplate> {
        if (await this.#client.Template.exists(name)) {
            return {
                name,
                immutableReference: name,
                action: 'cache-hit',
            };
        }
        const template = source.image
            ? this.#client.Template().fromImage(source.image)
            : source.context && source.dockerfile
              ? this.#client
                    .Template({ fileContextPath: source.context })
                    .fromDockerfile(source.dockerfile)
              : undefined;
        if (!template) throw new Error('E2B template source is incomplete');
        const built = await this.#client.Template.build(template, name);
        return {
            name,
            immutableReference: built.templateId,
            action: 'built',
        };
    }

    async createSandbox(options: {
        template: string;
        metadata: Record<string, string>;
        timeoutMilliseconds: number;
    }): Promise<E2BSandbox> {
        const sandbox = await this.#client.Sandbox.create(options.template, {
            metadata: options.metadata,
            timeoutMs: options.timeoutMilliseconds,
            allowInternetAccess: true,
            secure: true,
            lifecycle: {
                onTimeout: { action: 'pause', keepMemory: false },
                autoResume: false,
            },
        });
        return new SdkSandbox(sandbox);
    }

    async listManaged(scope: string): Promise<E2BManagedSandbox[]> {
        const paginator = this.#client.Sandbox.list({
            query: {
                metadata: {
                    [managedMetadata]: 'true',
                    [scopeMetadata]: scope,
                },
            },
        });
        const result: E2BManagedSandbox[] = [];
        while (paginator.hasNext) {
            for (const sandbox of await paginator.nextItems()) {
                const runId = sandbox.metadata[runMetadata];
                if (!runId) continue;
                result.push({
                    id: sandbox.sandboxId,
                    runId,
                    state: sandbox.state,
                });
            }
        }
        return result;
    }

    async killSandbox(id: string): Promise<void> {
        await this.#client.Sandbox.kill(id);
    }

    async connectSandbox(id: string, timeoutMilliseconds: number): Promise<E2BSandbox> {
        return new SdkSandbox(
            await this.#client.Sandbox.connect(id, { timeoutMs: timeoutMilliseconds })
        );
    }
}

export function e2bMetadata(run: {
    id: string;
    scope: string;
}): Record<string, string> {
    if (!/^wb_[a-z0-9]{20,64}$/.test(run.id)) {
        throw new Error(`Invalid Workbench run ID for E2B: ${run.id}`);
    }
    if (!/^[a-f0-9]{24}$/.test(run.scope)) {
        throw new Error(`Invalid Workbench E2B scope: ${run.scope}`);
    }
    return {
        [managedMetadata]: 'true',
        [runMetadata]: run.id,
        [scopeMetadata]: run.scope,
    };
}

class SdkSandbox implements E2BSandbox {
    constructor(private readonly sandbox: E2BSdkSandbox) {}

    get id(): string {
        return this.sandbox.sandboxId;
    }

    async pause(): Promise<void> {
        await this.sandbox.pause({ keepMemory: false });
    }

    async run(
        command: string,
        options: E2BRunOptions = {}
    ): Promise<{ code: number; stdout: string; stderr: string }> {
        try {
            const result = await this.sandbox.commands.run(command, {
                ...(options.user ? { user: options.user } : {}),
                ...(options.cwd ? { cwd: options.cwd } : {}),
                ...(options.env ? { envs: options.env } : {}),
                ...(options.onStdout ? { onStdout: options.onStdout } : {}),
                ...(options.onStderr ? { onStderr: options.onStderr } : {}),
                timeoutMs: 0,
            });
            return commandResult(result);
        } catch (error) {
            if (error instanceof CommandExitError) return commandResult(error);
            throw error;
        }
    }

    async start(command: string, options: E2BCommandOptions = {}): Promise<E2BCommand> {
        const handle = await this.sandbox.commands.run(command, {
            background: true,
            ...(options.cwd ? { cwd: options.cwd } : {}),
            ...(options.env ? { envs: options.env } : {}),
            ...(options.onStdout ? { onStdout: options.onStdout } : {}),
            ...(options.onStderr ? { onStderr: options.onStderr } : {}),
            stdin: options.stdin ?? false,
            timeoutMs: 0,
        });
        return new SdkCommand(handle);
    }

    async startPty(command: string, options: E2BPtyOptions): Promise<E2BPty> {
        const handle = await this.sandbox.pty.create({
            cols: options.columns,
            rows: options.rows,
            onData: options.onData,
            ...(options.cwd ? { cwd: options.cwd } : {}),
            ...(options.env ? { envs: options.env } : {}),
            timeoutMs: 0,
        });
        const terminal = new SdkPty(this.sandbox, handle);
        try {
            await terminal.sendInput(new TextEncoder().encode(`exec ${command}\r`));
        } catch (error) {
            await terminal.kill().catch(() => {});
            throw error;
        }
        return terminal;
    }

    async upload(path: string, data: ReadableStream<Uint8Array>): Promise<void> {
        await this.sandbox.files.write(path, data, {
            useOctetStream: true,
        });
    }

    download(path: string): Promise<ReadableStream<Uint8Array>> {
        return this.sandbox.files.read(path, {
            format: 'stream',
            streamIdleTimeoutMs: 60_000,
        });
    }

    async fileSize(path: string): Promise<number> {
        return (await this.sandbox.files.getInfo(path)).size;
    }

    async info(): Promise<E2BSandboxInfo> {
        const info = await this.sandbox.getInfo();
        return {
            startedAt: info.startedAt,
            endAt: info.endAt,
            cpuCount: info.cpuCount,
            memoryMB: info.memoryMB,
        };
    }

    host(port: number): string {
        return this.sandbox.getHost(port);
    }

    async kill(): Promise<void> {
        await this.sandbox.kill();
    }
}

class SdkCommand implements E2BCommand {
    constructor(private readonly handle: CommandHandle) {}

    get pid(): number {
        return this.handle.pid;
    }

    async wait(): Promise<{ code: number; stdout: string; stderr: string }> {
        try {
            return commandResult(await this.handle.wait());
        } catch (error) {
            if (error instanceof CommandExitError) return commandResult(error);
            throw error;
        }
    }

    sendStdin(data: string | Uint8Array): Promise<void> {
        return this.handle.sendStdin(data);
    }

    closeStdin(): Promise<void> {
        return this.handle.closeStdin();
    }

    async kill(): Promise<void> {
        await this.handle.kill();
    }
}

class SdkPty implements E2BPty {
    constructor(
        private readonly sandbox: E2BSdkSandbox,
        private readonly handle: CommandHandle
    ) {}

    get pid(): number {
        return this.handle.pid;
    }

    async wait(): Promise<{ code: number; stdout: string; stderr: string }> {
        try {
            return commandResult(await this.handle.wait());
        } catch (error) {
            if (error instanceof CommandExitError) return commandResult(error);
            throw error;
        }
    }

    sendInput(data: Uint8Array): Promise<void> {
        return this.sandbox.pty.sendInput(this.handle.pid, data);
    }

    resize(columns: number, rows: number): Promise<void> {
        return this.sandbox.pty.resize(this.handle.pid, {
            cols: columns,
            rows,
        });
    }

    async kill(): Promise<void> {
        await this.handle.kill();
    }
}

function commandResult(result: Pick<CommandResult, 'exitCode' | 'stdout' | 'stderr'>): {
    code: number;
    stdout: string;
    stderr: string;
} {
    return {
        code: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
    };
}
