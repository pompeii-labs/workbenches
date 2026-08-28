import type { RunnerInvocation, SpawnedRunner } from '../types.js';
import {
    type PreflightResult,
    WorkbenchPreflight,
    WorkbenchWorkspaces,
} from '../workbench/index.js';
import type {
    PreparedRuntime,
    RuntimeCommandResult,
    RuntimePrepareRequest,
    RuntimeProvider,
} from './contracts.js';
import { RuntimeError } from './error.js';

export interface LocalRuntimeDependencies {
    findExecutable?: (name: string) => string | null;
    spawn?: (
        command: string[],
        options: {
            cwd: string;
            env: Record<string, string | undefined>;
            stdin: 'ignore';
            stdout: 'pipe';
            stderr: 'pipe';
        }
    ) => SpawnedRunner;
    interact?: (
        command: string[],
        options: {
            cwd: string;
            env: Record<string, string | undefined>;
            stdin: 'inherit';
            stdout: 'inherit';
            stderr: 'inherit';
        }
    ) => Promise<number>;
}

export class LocalRuntimeProvider implements RuntimeProvider {
    readonly name = 'local';
    private readonly dependencies: Required<LocalRuntimeDependencies>;

    constructor(dependencies: LocalRuntimeDependencies = {}) {
        this.dependencies = {
            findExecutable: dependencies.findExecutable ?? Bun.which,
            spawn: dependencies.spawn ?? LocalRuntime.spawn,
            interact: dependencies.interact ?? LocalRuntime.interactProcess,
        };
    }

    async prepare(request: RuntimePrepareRequest): Promise<PreparedRuntime> {
        if (request.workbench.manifest.image) {
            throw new RuntimeError(
                this.name,
                'prepare',
                'image is not supported with the local runtime'
            );
        }
        return new LocalRuntime(request, this.dependencies);
    }
}

export class LocalRuntime implements PreparedRuntime {
    readonly name = 'local';
    readonly workbench;
    readonly workspaceDirectory;
    readonly environment;
    readonly workspaces;
    readonly preparation = { kind: 'host' as const };
    private ready = false;
    private cleaned = false;
    private readonly workspaceBindings = new WorkbenchWorkspaces();

    constructor(
        request: RuntimePrepareRequest,
        private readonly dependencies: Required<LocalRuntimeDependencies>
    ) {
        this.workbench = request.workbench;
        this.workspaceDirectory = request.workspaceDirectory;
        this.workspaces = request.assets.flatMap((asset) =>
            asset.workspace
                ? [
                      {
                          name: asset.workspace,
                          path: asset.path,
                          access: asset.access,
                      },
                  ]
                : []
        );
        this.environment = {
            ...request.environment,
            ...this.workspaceBindings.environment(this.workspaces),
        };
    }

    pathFor(hostPath: string): string {
        return hostPath;
    }

    async preflight(): Promise<PreflightResult> {
        this.assertAvailable('preflight');
        try {
            const result = new WorkbenchPreflight({
                environment: this.environment,
                findExecutable: this.dependencies.findExecutable,
            }).check(this.workbench);
            this.ready = true;
            return { ...result, workspaces: this.workspaces };
        } catch (error) {
            throw RuntimeError.from(this.name, 'preflight', error);
        }
    }

    async execute(invocation: RunnerInvocation): Promise<RuntimeCommandResult> {
        this.assertAvailable('launch');
        const child = this.dependencies.spawn(invocation.command, {
            cwd: invocation.cwd,
            env: invocation.env,
            stdin: 'ignore',
            stdout: 'pipe',
            stderr: 'pipe',
        });
        const [code, stdout, stderr] = await Promise.all([
            child.exited,
            LocalRuntime.read(child.stdout),
            LocalRuntime.read(child.stderr),
        ]);
        return { code, stdout, stderr };
    }

    interact(invocation: RunnerInvocation): Promise<number> {
        this.assertAvailable('launch');
        return this.dependencies.interact(invocation.command, {
            cwd: invocation.cwd,
            env: invocation.env,
            stdin: 'inherit',
            stdout: 'inherit',
            stderr: 'inherit',
        });
    }

    launch(invocation: RunnerInvocation): SpawnedRunner {
        this.assertAvailable('launch');
        if (!this.ready) {
            throw new RuntimeError(
                this.name,
                'launch',
                'Runtime preflight must succeed before launch'
            );
        }
        try {
            return this.dependencies.spawn(invocation.command, {
                cwd: invocation.cwd,
                env: invocation.env,
                stdin: 'ignore',
                stdout: 'pipe',
                stderr: 'pipe',
            });
        } catch (error) {
            throw RuntimeError.from(this.name, 'launch', error);
        }
    }

    cancel(process: SpawnedRunner): void {
        try {
            process.kill?.();
        } catch (error) {
            throw RuntimeError.from(this.name, 'cancel', error);
        }
    }

    async cleanup(): Promise<void> {
        this.cleaned = true;
    }

    private assertAvailable(phase: 'preflight' | 'launch'): void {
        if (this.cleaned) {
            throw new RuntimeError(
                this.name,
                phase,
                'Runtime has already been cleaned up'
            );
        }
    }

    static spawn(
        command: string[],
        options: Parameters<NonNullable<LocalRuntimeDependencies['spawn']>>[1]
    ): SpawnedRunner {
        return Bun.spawn(command, options);
    }

    static async interactProcess(
        command: string[],
        options: Parameters<NonNullable<LocalRuntimeDependencies['interact']>>[1]
    ): Promise<number> {
        return Bun.spawn(command, options).exited;
    }

    private static async read(
        stream: ReadableStream<Uint8Array> | undefined
    ): Promise<string> {
        if (!stream) return '';
        return new Response(stream).text();
    }
}
