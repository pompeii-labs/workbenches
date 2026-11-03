import type { OutcomeSink, RuntimeOutcomeCollection } from '../outcomes/collection.js';
import { HostOutcomeCapture } from '../outcomes/runtime.js';
import { ProcessProbe } from '../processes/probe.js';
import type { RunnerInvocation, SpawnedRunner } from '../types.js';
import { workspaceEnvironment } from '../workbench/bindings.js';
import type { HostDescriber } from '../workbench/host.js';
import { type PreflightResult, WorkbenchPreflight } from '../workbench/preflight.js';
import { RequirementsPreflight } from '../workbench/requirements.js';
import { selectedRuntime } from '../workbench/runtimes.js';
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
import { readCredentialRoot, withoutHostVariables } from './hostvariables.js';
import { runnerExecutable } from './runner.js';

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
    /** How long a short command may run before it is stopped. */
    commandTimeoutMs?: number;
    /** Describes the machine requirements are checked against. */
    host: HostDescriber;
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

type ResolvedLocalDependencies = Required<
    Omit<LocalRuntimeDependencies, 'host' | 'findExecutable'>
> & {
    /** Finds a command on `path`, the `PATH` the run is launched with. */
    findExecutable: (name: string, path?: string) => string | null;
};

const processes = new ProcessProbe();

export class LocalRuntimeProvider implements RuntimeProvider {
    readonly name = 'local';
    readonly placement = 'host' as const;
    private readonly dependencies: ResolvedLocalDependencies;
    private readonly requirements: RequirementsPreflight;

    constructor(dependencies: LocalRuntimeDependencies) {
        this.dependencies = {
            findExecutable:
                dependencies.findExecutable ??
                ((name: string, path?: string) =>
                    Bun.which(name, path === undefined ? undefined : { PATH: path })),
            spawn: dependencies.spawn ?? LocalRuntime.spawn,
            interact: dependencies.interact ?? LocalRuntime.interactProcess,
            commandTimeoutMs: dependencies.commandTimeoutMs ?? 30_000,
        };
        this.requirements = new RequirementsPreflight(dependencies.host);
    }

    async prepare(request: RuntimePrepareRequest): Promise<PreparedRuntime> {
        if (selectedRuntime(request.workbench).image) {
            throw new RuntimeError(
                this.name,
                'prepare',
                'image is not supported with the local runtime'
            );
        }
        await this.checkRequirements(request);
        const outcome = request.outcome
            ? await HostOutcomeCapture.create(request, {
                  bestEffortWorkspaceChanges: !request.repository,
                  gitBaseline: true,
              })
            : undefined;
        return new LocalRuntime(request, this.dependencies, this.requirements, outcome);
    }

    /**
     * Host requirements are checked here. A GPU requirement passes when
     * discovery finds a GPU on the host, or when the request carries the
     * caller's explicit acknowledgement of a GPU discovery cannot see.
     */
    private async checkRequirements(request: RuntimePrepareRequest): Promise<void> {
        try {
            await this.requirements.verify(request.workbench, {
                allowUncheckedGpu: request.allowUncheckedGpu ?? false,
            });
        } catch (error) {
            throw RuntimeError.from(this.name, 'prepare', error);
        }
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
    private readonly servicePorts = new Set<number>();
    private readonly requiresGitHubCli;
    private readonly allowUncheckedGpu: boolean;
    /** The runner CLI the host must provide. */
    private readonly executable: string;
    readonly credentialRoot: string | undefined;
    /** The `PATH` the run is launched with, where its commands are looked for. */
    private readonly path: string | undefined;

    constructor(
        request: RuntimePrepareRequest,
        private readonly dependencies: ResolvedLocalDependencies,
        private readonly requirementsPreflight: RequirementsPreflight,
        private readonly outcome?: HostOutcomeCapture
    ) {
        this.allowUncheckedGpu = request.allowUncheckedGpu ?? false;
        this.executable = runnerExecutable(request);
        this.requiresGitHubCli = request.repository?.delivery === 'pr';
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
        this.credentialRoot = readCredentialRoot(request.environment);
        this.path = request.environment.PATH;
        this.environment = {
            ...withoutHostVariables(request.environment),
            ...(request.repository
                ? {
                      WORKBENCH_REPOSITORY: request.repository.name,
                      WORKBENCH_REPOSITORY_REVISION: request.repository.revision,
                  }
                : {}),
            ...workspaceEnvironment(this.workspaces),
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
            // A command is found where the run will launch it: on its own PATH.
            const findExecutable = (name: string) =>
                this.dependencies.findExecutable(name, this.path);
            if (this.requiresGitHubCli && !findExecutable('gh'))
                throw new Error(
                    'GitHub CLI (gh) is required for authenticated repository runs'
                );
            const result = new WorkbenchPreflight({
                environment: this.environment,
                findExecutable,
            }).check(this.workbench, this.executable);
            const requirements = await this.requirementsPreflight.verify(
                this.workbench,
                {
                    allowUncheckedGpu: this.allowUncheckedGpu,
                }
            );
            this.ready = true;
            return { ...result, workspaces: this.workspaces, requirements };
        } catch (error) {
            throw RuntimeError.from(this.name, 'preflight', error);
        }
    }

    /**
     * Runs a short command, such as a runner's sign-in listing, and stops it
     * when it outlives the limit, failing with exit code 124 as `timeout` does.
     * A runner reading the person's own data home can stall on it, and nothing
     * else would end the wait.
     */
    async execute(invocation: RunnerInvocation): Promise<RuntimeCommandResult> {
        this.assertAvailable('launch');
        const child = this.dependencies.spawn(invocation.command, {
            cwd: invocation.cwd,
            env: withoutHostVariables(invocation.env),
            stdin: 'ignore',
            stdout: 'pipe',
            stderr: 'pipe',
        });
        let expired = false;
        const limit = setTimeout(() => {
            expired = true;
            // A shell wrapper's own children outlive it unless stopped with it.
            const started = child.pid ? processes.descendants(child.pid) : [];
            child.kill?.();
            for (const pid of started) {
                try {
                    process.kill(pid, 'SIGTERM');
                } catch {}
            }
        }, this.dependencies.commandTimeoutMs);
        const [code, stdout, stderr] = await Promise.all([
            child.exited,
            LocalRuntime.read(child.stdout),
            LocalRuntime.read(child.stderr),
        ]).finally(() => clearTimeout(limit));
        if (expired) {
            return {
                code: 124,
                stdout,
                stderr: `Stopped after ${this.dependencies.commandTimeoutMs / 1000} seconds without finishing`,
            };
        }
        return { code, stdout, stderr };
    }

    interact(invocation: RunnerInvocation): Promise<number> {
        this.assertAvailable('launch');
        return this.dependencies.interact(invocation.command, {
            cwd: invocation.cwd,
            env: withoutHostVariables(invocation.env),
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
                env: withoutHostVariables(invocation.env),
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
            resolveUrl: async (reportedUrl) => {
                const port = URL.canParse(reportedUrl)
                    ? Number(new URL(reportedUrl).port)
                    : 0;
                if (Number.isInteger(port) && port > 0) this.servicePorts.add(port);
                return reportedUrl;
            },
        };
    }

    reservedPorts(): number[] {
        return [...this.servicePorts];
    }

    cancel(process: SpawnedRunner): void {
        try {
            process.kill?.();
        } catch (error) {
            throw RuntimeError.from(this.name, 'cancel', error);
        }
    }

    async collectOutcome(
        store: OutcomeSink
    ): Promise<RuntimeOutcomeCollection | undefined> {
        return this.outcome?.collect(store);
    }

    async snapshotRepository(store: OutcomeSink) {
        return this.outcome?.snapshot(store);
    }

    async cleanup(): Promise<void> {
        this.cleaned = true;
        await this.outcome?.cleanup();
    }

    collectOutput(store: OutcomeSink) {
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
            pid: child.pid,
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
