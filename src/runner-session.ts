import type { WorkbenchEventDraft } from './execution.js';
import type { ResolvedWorkbench } from './types.js';

export const RUNNER_CAPABILITIES = [
    'streaming_text',
    'tool_events',
    'file_events',
    'usage',
    'permissions',
    'multi_turn',
    'cancellation',
    'failures',
    'unknown_events',
] as const;

export type RunnerCapability = (typeof RUNNER_CAPABILITIES)[number];
export type RunnerCapabilityStatus = 'supported' | 'degraded' | 'unsupported';

export interface RunnerCapabilitySupport {
    status: RunnerCapabilityStatus;
    detail?: string;
}

export interface VerifiedRunnerSurface {
    version: string;
    surfaces: string[];
}

export interface RunnerAdapterDeclaration {
    native: {
        command: string;
        verified: VerifiedRunnerSurface[];
    };
    capabilities: Record<RunnerCapability, RunnerCapabilitySupport>;
}

export interface RunnerTurnResult {
    reason?: string;
}

export type RunnerPermissionDecision = 'allow_once' | 'allow_always' | 'reject';

export interface RunnerPermissionRequest {
    id: string;
    action: string;
    resources: string[];
    message: string;
    allowAlways: boolean;
}

export interface RunnerSession {
    readonly id: string | undefined;
    prompt(input: string): Promise<RunnerTurnResult>;
    cancelTurn(): Promise<void>;
    close(): Promise<void>;
}

export interface RunnerSessionHost {
    emit(event: WorkbenchEventDraft): Promise<void>;
    requestPermission(
        request: RunnerPermissionRequest
    ): Promise<RunnerPermissionDecision>;
}

export interface RunnerSessionStartOptions {
    workbench: ResolvedWorkbench;
    workspaceDirectory: string;
    environment: Record<string, string | undefined>;
    host: RunnerSessionHost;
}

export interface RunnerSessionAdapter {
    readonly runner: string;
    readonly declaration: RunnerAdapterDeclaration;
    start(options: RunnerSessionStartOptions): Promise<RunnerSession>;
}

export class RunnerSessionRegistry {
    private readonly adapters = new Map<string, RunnerSessionAdapter>();

    constructor(adapters: RunnerSessionAdapter[]) {
        for (const adapter of adapters) {
            const runner = adapter.runner.trim();
            if (!runner) throw new Error('Runner adapter name must not be empty');
            if (this.adapters.has(runner)) {
                throw new Error(`Duplicate interactive runner adapter: ${runner}`);
            }
            validateDeclaration(runner, adapter.declaration);
            this.adapters.set(runner, adapter);
        }
    }

    resolve(runner: string): RunnerSessionAdapter {
        const adapter = this.adapters.get(runner);
        if (!adapter) {
            throw new Error(
                `Interactive sessions are unavailable for runner: ${runner}`
            );
        }
        return adapter;
    }
}

function validateDeclaration(
    runner: string,
    declaration: RunnerAdapterDeclaration
): void {
    if (!declaration) {
        throw new Error(`Runner adapter declaration is required: ${runner}`);
    }
    if (!declaration.native.command.trim()) {
        throw new Error(`Runner adapter native command must not be empty: ${runner}`);
    }
    if (declaration.native.verified.length === 0) {
        throw new Error(
            `Runner adapter must declare a verified native version: ${runner}`
        );
    }
    for (const verified of declaration.native.verified) {
        if (!verified.version.trim() || verified.surfaces.length === 0) {
            throw new Error(
                `Runner adapter verified versions require native surfaces: ${runner}`
            );
        }
        if (verified.surfaces.some((surface) => !surface.trim())) {
            throw new Error(
                `Runner adapter native surfaces must not be empty: ${runner}`
            );
        }
    }
    for (const capability of RUNNER_CAPABILITIES) {
        const support = declaration.capabilities[capability];
        if (!support) {
            throw new Error(
                `Runner adapter capability is not declared: ${runner}.${capability}`
            );
        }
        if (!['supported', 'degraded', 'unsupported'].includes(support.status)) {
            throw new Error(
                `Runner adapter capability status is invalid: ${runner}.${capability}`
            );
        }
        if (support.status !== 'supported' && !support.detail?.trim()) {
            throw new Error(
                `Runner adapter ${support.status} capability requires detail: ${runner}.${capability}`
            );
        }
    }
}
