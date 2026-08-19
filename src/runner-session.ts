import type { WorkbenchEventDraft } from './execution.js';
import type { ResolvedWorkbench } from './types.js';

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
