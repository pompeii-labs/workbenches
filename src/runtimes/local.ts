import {
    HostOutcomeCapture,
    type OutcomeStore,
    type RuntimeOutcomeCollection,
} from '../outcomes/index.js';
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
    RuntimeService,
    RuntimeServiceBinding,
    RuntimeSessionOptions,
} from './contracts.js';
import { RuntimeError } from './error.js';

export interface LocalRuntimeDependencies {
    findExecutable?: (name: string) => string | null;
    spawn?: (
        command: string[],
        options: {
            cwd: string;
            env: Record<string, string | undefined>;
            stdin: 'ignore' | 'pipe';
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
        const outcome = request.outcome
            ? await HostOutcomeCapture.create(request)
            : undefined;
        return new LocalRuntime(request, this.dependencies, outcome);
    }
}

export class LocalRuntime implements PreparedRuntime {
    readonly name = 'local';
    readonly nativeAuthentication = 'persistent' as const;
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
        private readonly dependencies: Required<LocalRuntimeDependencies>,
        private readonly outcome?: HostOutcomeCapture
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
            ...(request.outcome
                ? { WORKBENCH_OUTPUT_DIR: request.outcome.directory }
                : {}),
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
        return this.launchSession(invocation, { stdin: 'ignore' });
    }

    launchSession(
        invocation: RunnerInvocation,
        options: RuntimeSessionOptions
    ): SpawnedRunner {
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
                stdin: options.stdin,
                stdout: 'pipe',
                stderr: 'pipe',
            });
        } catch (error) {
            throw RuntimeError.from(this.name, 'launch', error);
        }
    }

    launchService(
        buildInvocation: (binding: RuntimeServiceBinding) => RunnerInvocation
    ): RuntimeService {
        const process = this.launchSession(
            buildInvocation({ hostname: '127.0.0.1', port: 0 }),
            { stdin: 'ignore' }
        );
        return {
            process,
            resolveUrl: async (reportedUrl) => reportedUrl,
        };
    }

    cancel(process: SpawnedRunner): void {
        try {
            process.kill?.();
        } catch (error) {
            throw RuntimeError.from(this.name, 'cancel', error);
        }
    }

    async collectOutcome(
        store: OutcomeStore
    ): Promise<RuntimeOutcomeCollection | undefined> {
        return this.outcome?.collect(store);
    }

    async cleanup(): Promise<void> {
        this.cleaned = true;
        await this.outcome?.cleanup();
    }

    collectOutput(store: OutcomeStore) {
        return this.outcome?.collectOutput(store) ?? Promise.resolve(undefined);
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
        const child = Bun.spawn(command, options);
        let forceTermination: ReturnType<typeof setTimeout> | undefined;
        const exited = child.exited.finally(() => clearTimeout(forceTermination));
        return {
            exited,
            ...(child.stdin ? { stdin: child.stdin } : {}),
            ...(child.stdout ? { stdout: child.stdout } : {}),
            ...(child.stderr ? { stderr: child.stderr } : {}),
            kill: () => {
                if (child.exitCode !== null) return;
                child.kill('SIGTERM');
                if (forceTermination) return;
                // Native harnesses can handle SIGTERM without exiting. Do not
                // leave session shutdown and final result capture waiting forever.
                forceTermination = setTimeout(() => {
                    if (child.exitCode === null) child.kill('SIGKILL');
                }, 2_000);
                forceTermination.unref();
            },
        };
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
