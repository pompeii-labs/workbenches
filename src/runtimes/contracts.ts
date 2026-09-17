import type { OutcomeStore, RuntimeOutcomeCollection } from '../outcomes/index.js';
import type { CollectedOutput } from '../outcomes/output.js';
import type {
    ResolvedWorkbench,
    RunnerInvocation,
    SpawnedRunner,
    WorkbenchWorkspaceBinding,
} from '../types.js';
import type { PreflightResult } from '../workbench/index.js';

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
    purpose?: 'build' | 'connect' | 'run';
    run?: { id: string; scope: string };
    outcome?: { directory: string; home?: string };
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
    collectOutcome?(store: OutcomeStore): Promise<RuntimeOutcomeCollection | undefined>;
    /** Collect returned files and links without finalizing native state or workspace diffs. */
    collectOutput?(store: OutcomeStore): Promise<CollectedOutput | undefined>;
    finalizeOutcome?(): Promise<void>;
    cleanup(): Promise<void>;
}

export interface RuntimeProvider {
    readonly name: string;
    prepare(request: RuntimePrepareRequest): Promise<PreparedRuntime>;
}
