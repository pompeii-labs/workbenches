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
    | 'cleanup';

export interface RuntimeAsset {
    path: string;
    access: 'read-only' | 'read-write';
    workspace?: string;
}

export interface RuntimePrepareRequest {
    workbench: ResolvedWorkbench;
    workspaceDirectory: string;
    environment: Record<string, string | undefined>;
    assets: RuntimeAsset[];
    authorizations?: { hostDocker: boolean };
    purpose?: 'build' | 'connect' | 'run';
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
    pathFor(hostPath: string): string;
    preflight(): Promise<PreflightResult>;
    execute(
        invocation: RunnerInvocation,
        options?: RuntimeCommandOptions
    ): Promise<RuntimeCommandResult>;
    interact(invocation: RunnerInvocation): Promise<number>;
    launch(invocation: RunnerInvocation): SpawnedRunner;
    cancel(process: SpawnedRunner): void;
    cleanup(): Promise<void>;
}

export interface RuntimeProvider {
    readonly name: string;
    prepare(request: RuntimePrepareRequest): Promise<PreparedRuntime>;
}
