import type {
    CollectedOutput,
    OutcomeSink,
    RuntimeOutcomeCollection,
} from '../../outcomes/collection.js';
import type {
    ResolvedWorkbench,
    RunnerInvocation,
    SpawnedRunner,
    WorkbenchWorkspaceBinding,
} from '../../types.js';
import { workspaceEnvironment } from '../../workbench/bindings.js';
import type { PreflightResult } from '../../workbench/preflight.js';
import type { RequirementsPreflight } from '../../workbench/requirements.js';
import type {
    PreparedRuntime,
    RuntimeCommandOptions,
    RuntimeCommandResult,
    RuntimeInfrastructureMetadata,
    RuntimePreparation,
    RuntimePrepareRequest,
    RuntimeService,
    RuntimeServiceBinding,
    RuntimeSessionOptions,
} from '../contracts.js';
import { RuntimeError } from '../error.js';
import type { TransferRules } from '../staging/rules.js';
import { definedEnvironment, quote, shellCommand } from '../staging/shell.js';
import type {
    OutcomeCollector,
    RemoteTransfer,
    StagedAsset,
    TransferSandbox,
} from '../staging/transfer.js';
import type { PathPlan } from './paths.js';
import {
    type RemoteCommand,
    type RemoteCommandOptions,
    RemoteProcess,
} from './process.js';

/** How a sandbox runs a command to completion. */
export interface RemoteRunOptions {
    cwd?: string;
    env?: Record<string, string>;
    /** Run with root privileges. Used only to provision staging directories. */
    user?: 'root';
}

/** What a prepared remote runtime needs from the sandbox it drives. */
export interface RemoteSandbox extends TransferSandbox {
    readonly id: string;
    /** Runs a shell command to completion. */
    run(command: string, options?: RemoteRunOptions): Promise<RuntimeCommandResult>;
    /** Starts a shell command and streams its output. */
    start(command: string, options?: RemoteCommandOptions): Promise<RemoteCommand>;
}

export interface RemoteRuntimeOptions {
    request: RuntimePrepareRequest;
    paths: PathPlan;
    rules: TransferRules;
    /** Packs files into the sandbox and takes outcomes and native state back. */
    transfer: RemoteTransfer;
    requirements: RequirementsPreflight;
    run: { id: string; scope: string };
    maximumTransferBytes: number;
    /** The longest a sandbox may live. The provider also asks its platform to enforce it. */
    leaseMilliseconds: number;
    now(): Date;
}

/**
 * A prepared runtime whose runner executes inside a sandbox the engine copies
 * files into. It owns what every such runtime shares: the path mapping, the
 * running processes, native state and outcome collection, and the order of
 * cleanup. A provider's subclass owns how its sandbox is created, checked,
 * reached, and destroyed.
 */
export abstract class RemoteRuntime<S extends RemoteSandbox, A extends StagedAsset>
    implements PreparedRuntime
{
    abstract readonly name: string;
    abstract readonly nativeAuthentication: 'persistent' | 'unavailable';
    abstract readonly preparation: RuntimePreparation;
    readonly workbench: ResolvedWorkbench;
    readonly workspaceDirectory: string;
    readonly environment: Record<string, string | undefined>;
    readonly workspaces: WorkbenchWorkspaceBinding[];
    protected sandbox: S | undefined;
    protected snapshots: A[] = [];
    protected readonly snapshotBaselines = new Map<number, string>();
    protected readonly persistedState = new Set<number>();
    protected ready = false;
    protected cleaned = false;
    protected sandboxStartedAt: number | undefined;
    private readonly active = new Set<RemoteProcess>();
    private statePersistence: Promise<void> | undefined;
    private outcomeCollection: Promise<RuntimeOutcomeCollection> | undefined;
    private finalInfrastructure: RuntimeInfrastructureMetadata | undefined;

    protected constructor(protected readonly options: RemoteRuntimeOptions) {
        this.workspaceDirectory = options.paths.pathFor(
            options.request.workspaceDirectory
        );
        this.workspaces = options.request.assets.flatMap((asset) =>
            asset.workspace
                ? [
                      {
                          name: asset.workspace,
                          path: options.paths.pathFor(asset.path),
                          access: asset.access,
                      },
                  ]
                : []
        );
        this.environment = {
            ...options.paths.environment(),
            ...workspaceEnvironment(this.workspaces),
        };
        this.workbench = options.paths.remap(options.request.workbench);
    }

    pathFor(hostPath: string): string {
        return this.options.paths.pathFor(hostPath);
    }

    abstract preflight(): Promise<PreflightResult>;
    abstract interact(invocation: RunnerInvocation): Promise<number>;
    abstract launchService(
        buildInvocation: (binding: RuntimeServiceBinding) => RunnerInvocation
    ): RuntimeService;

    async execute(
        invocation: RunnerInvocation,
        _options: RuntimeCommandOptions = {}
    ): Promise<RuntimeCommandResult> {
        const sandbox = this.requireReady();
        return sandbox.run(shellCommand(invocation.command), {
            cwd: invocation.cwd,
            env: definedEnvironment(invocation.env),
        });
    }

    launch(invocation: RunnerInvocation): SpawnedRunner {
        return this.launchSession(invocation, { stdin: 'ignore' });
    }

    launchSession(
        invocation: RunnerInvocation,
        options: RuntimeSessionOptions
    ): SpawnedRunner {
        const sandbox = this.requireReady();
        return this.track(
            new RemoteProcess(
                {
                    start: (output) =>
                        sandbox.start(shellCommand(invocation.command), {
                            cwd: invocation.cwd,
                            env: definedEnvironment(invocation.env),
                            stdin: options.stdin === 'pipe',
                            ...output,
                        }),
                },
                options.stdin === 'pipe'
            )
        );
    }

    cancel(process: SpawnedRunner): void {
        const active = [...this.active].find(
            (candidate) => candidate.spawned === process
        );
        process.kill?.();
        if (active) this.active.delete(active);
    }

    async infrastructure(): Promise<RuntimeInfrastructureMetadata> {
        if (this.finalInfrastructure) return this.finalInfrastructure;
        return this.measureInfrastructure();
    }

    async collectOutcome(store: OutcomeSink): Promise<RuntimeOutcomeCollection> {
        if (!this.outcomeCollection) {
            this.outcomeCollection = this.persistNativeState()
                .then(() => this.collector().collect(store))
                .catch((error) => {
                    this.outcomeCollection = undefined;
                    throw this.collectionFailure(error);
                });
        }
        return this.outcomeCollection;
    }

    snapshotRepository(store: OutcomeSink): Promise<RuntimeOutcomeCollection> {
        return this.collector().collect(store);
    }

    collectOutput(store: OutcomeSink): Promise<CollectedOutput> {
        return this.collector().collectOutput(store);
    }

    async finalizeOutcome(): Promise<void> {}

    /**
     * Stops running commands, saves native state, destroys the sandbox through
     * the subclass, and removes local snapshots. Every step runs, and the first
     * failure is thrown at the end.
     */
    async cleanup(): Promise<void> {
        if (this.cleaned) return;
        this.cleaned = true;
        for (const active of this.active) await active.kill();
        this.active.clear();
        const failures: unknown[] = [];
        await this.persistNativeState().catch((error) => {
            failures.push(error);
        });
        if (this.sandbox) {
            this.finalInfrastructure = await this.measureInfrastructure();
        }
        await this.destroy(failures);
        const snapshotCleanup = await Promise.allSettled(
            this.snapshots
                .filter((snapshot) => this.releasable(snapshot))
                .map((snapshot) => snapshot.cleanup())
        );
        for (const result of snapshotCleanup) {
            if (result.status === 'rejected') failures.push(result.reason);
        }
        await this.finishCleanup().catch((error) => failures.push(error));
        if (failures[0]) throw failures[0];
    }

    /** Destroys the sandbox, if there is one, and records any failure. */
    protected abstract destroy(failures: unknown[]): Promise<void>;

    protected abstract measureInfrastructure(): Promise<RuntimeInfrastructureMetadata>;

    /** Called with the snapshot indexes whose native state is saved so far. */
    protected async checkpoint(_completed: Set<number>): Promise<void> {}

    /** The error to throw when collecting the outcome fails. */
    protected collectionFailure(error: unknown): unknown {
        return error;
    }

    /** False for a snapshot that must outlive cleanup. */
    protected releasable(_snapshot: A): boolean {
        return true;
    }

    /** Runs after local snapshots are removed. */
    protected async finishCleanup(): Promise<void> {}

    /** Follows `remote` until it exits, so cleanup stops only what still runs. */
    protected track(remote: RemoteProcess): SpawnedRunner {
        this.active.add(remote);
        const forget = () => {
            this.active.delete(remote);
        };
        remote.spawned.exited.then(forget, forget);
        return remote.spawned;
    }

    protected collector(): OutcomeCollector {
        return this.options.transfer.collector({
            sandbox: this.requireReady(),
            snapshots: this.snapshots,
            baselines: this.snapshotBaselines,
            maximumTransferBytes: this.options.maximumTransferBytes,
        });
    }

    protected persistNativeState(): Promise<void> {
        if (!this.sandbox) return Promise.resolve();
        if (!this.statePersistence) {
            this.statePersistence = this.options.transfer
                .captureNativeState({
                    sandbox: this.sandbox,
                    snapshots: this.snapshots,
                    maximumBytes: this.options.maximumTransferBytes,
                    completed: this.persistedState,
                    checkpoint: (completed) => this.checkpoint(completed),
                })
                .catch((error) => {
                    this.statePersistence = undefined;
                    throw error;
                });
        }
        return this.statePersistence;
    }

    protected async preflightAssets(sandbox: S): Promise<void> {
        const paths = [
            this.workbench.instructionsPath,
            ...this.workbench.skills.map((skill) => skill.manifestPath),
        ];
        for (const path of paths) {
            const result = await sandbox.run(`test -r ${quote(path)}`);
            if (result.code !== 0) {
                throw new Error(`Required runtime asset is unreadable: ${path}`);
            }
        }
    }

    /** Seconds left of the lease, never less than a minute. */
    protected leaseSeconds(): number {
        const elapsed = this.options.now().getTime() - (this.sandboxStartedAt ?? 0);
        return Math.max(60, (this.options.leaseMilliseconds - elapsed) / 1_000);
    }

    protected requireReady(): S {
        this.assertAvailable('launch');
        if (!this.ready || !this.sandbox) {
            throw new Error('Runtime preflight must succeed before launch');
        }
        return this.sandbox;
    }

    protected assertAvailable(phase: 'preflight' | 'launch'): void {
        if (this.cleaned) {
            throw new RuntimeError(
                this.name,
                phase,
                'Runtime has already been cleaned up'
            );
        }
    }
}
