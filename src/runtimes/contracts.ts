import type {
    CollectedOutput,
    OutcomeSink,
    RuntimeOutcomeCollection,
} from '../outcomes/collection.js';
import type {
    ResolvedWorkbench,
    RunnerInvocation,
    SpawnedRunner,
    WorkbenchWorkspaceBinding,
} from '../types.js';
import type { PreflightResult } from '../workbench/preflight.js';

export type RuntimePhase =
    | 'resolve'
    | 'prepare'
    | 'mount'
    | 'bind'
    | 'preflight'
    | 'launch'
    | 'cancel'
    | 'collect'
    | 'cleanup';

export interface RuntimeAsset {
    path: string;
    access: 'read-only' | 'read-write';
    workspace?: string;
    state?: boolean;
    git?: boolean;
}

export interface RuntimeCredentialBinding {
    runtime: string;
    runner: string;
    directory: string;
}

export interface RuntimePrepareRequest {
    workbench: ResolvedWorkbench;
    workspaceDirectory: string;
    environment: Record<string, string | undefined>;
    assets: RuntimeAsset[];
    credentials?: RuntimeCredentialBinding;
    authorizations?: { hostDocker: boolean };
    /** The caller accepted a GPU requirement the runtime cannot verify. */
    allowUncheckedGpu?: boolean;
    purpose?: 'build' | 'connect' | 'run';
    run?: { id: string; scope: string };
    outcome?: { directory: string; home?: string };
    repository?: { name: string; revision: string; delivery: 'none' | 'pr' };
}

export interface RuntimeCommandOptions {
    network?: 'none' | 'bridge';
    readOnly?: boolean;
}

export interface RuntimeCommandResult {
    code: number;
    stdout: string;
    stderr: string;
}

export interface RuntimeSessionOptions {
    stdin: 'ignore' | 'pipe';
}

export interface RuntimeServiceBinding {
    hostname: string;
    port: number;
}

export interface RuntimeService {
    process: SpawnedRunner;
    resolveUrl(reportedUrl: string): Promise<string>;
}

export interface RuntimeInfrastructureMetadata {
    provider: string;
    duration_ms: number;
    maximum_duration_ms?: number;
    resources?: {
        cpu_count?: number;
        memory_mb?: number;
    };
    cost:
        | {
              kind: 'estimated';
              currency: 'USD';
              amount_usd: number;
              source: string;
          }
        | {
              kind: 'unavailable';
              currency: 'USD';
          };
}

export interface RuntimePreparation {
    kind: 'host' | 'image';
    reference?: string;
    immutableReference?: string;
    action?: 'pulled' | 'built' | 'cache-hit';
    cacheKey?: string;
    excludedPaths?: string[];
}

export interface PreparedRuntime {
    readonly name: string;
    readonly workbench: ResolvedWorkbench;
    readonly workspaceDirectory: string;
    readonly environment: Record<string, string | undefined>;
    readonly workspaces: WorkbenchWorkspaceBinding[];
    readonly preparation?: RuntimePreparation;
    /**
     * The id of the remote sandbox backing this runtime, once one exists. A
     * remote runtime reports it so a host can keep it and reconnect later. Local
     * runtimes leave it out.
     */
    readonly sandboxId?: string | undefined;
    readonly nativeAuthentication: 'persistent' | 'unavailable';
    pathFor(hostPath: string): string;
    preflight(): Promise<PreflightResult>;
    execute(
        invocation: RunnerInvocation,
        options?: RuntimeCommandOptions
    ): Promise<RuntimeCommandResult>;
    interact(invocation: RunnerInvocation): Promise<number>;
    launch(invocation: RunnerInvocation): SpawnedRunner;
    launchSession(
        invocation: RunnerInvocation,
        options: RuntimeSessionOptions
    ): SpawnedRunner;
    launchService(
        buildInvocation: (binding: RuntimeServiceBinding) => RunnerInvocation
    ): RuntimeService;
    cancel(process: SpawnedRunner): void;
    infrastructure?(): Promise<RuntimeInfrastructureMetadata | undefined>;
    collectOutcome?(store: OutcomeSink): Promise<RuntimeOutcomeCollection | undefined>;
    /** Capture repository changes during execution without finalizing or caching them. */
    snapshotRepository?(
        store: OutcomeSink
    ): Promise<RuntimeOutcomeCollection | undefined>;
    /** Collect returned files and links without finalizing native state or workspace diffs. */
    collectOutput?(store: OutcomeSink): Promise<CollectedOutput | undefined>;
    finalizeOutcome?(): Promise<void>;
    cleanup(): Promise<void>;
}

/**
 * Where a provider runs a Workbench: on the host, in a container that mounts
 * host directories, or in a sandbox the engine copies files into.
 */
export type RuntimePlacement = 'host' | 'container' | 'sandbox';

export interface RuntimeProvider {
    readonly name: string;
    readonly placement: RuntimePlacement;
    prepare(request: RuntimePrepareRequest): Promise<PreparedRuntime>;
}
