import type { ResolvedRunnerConfiguration } from '../models/index.js';
import type { WorkbenchEventDraft } from '../runs/index.js';
import type { PreparedRuntime, RuntimeAsset } from '../runtimes/contracts.js';
import type { ResolvedWorkbench, RunnerInvocation } from '../types.js';
import type { RunnerSessionAdapter } from './session.js';

export interface RunnerSummary {
    finalText: string;
    turnCompleted: boolean;
    failureMessage?: string;
}

export interface RunnerEventNormalizer {
    consume(value: unknown): { events: WorkbenchEventDraft[] };
    summary(): RunnerSummary;
}

export interface PreparedRunner {
    readonly name: string;
    readonly failureLabel: string;
    readonly assets: RuntimeAsset[];
    build(
        runtime: PreparedRuntime,
        task: string,
        configuration: ResolvedRunnerConfiguration
    ): RunnerInvocation;
    native(runtime: PreparedRuntime, command: string[]): RunnerInvocation;
    publicInvocation(invocation: RunnerInvocation): Record<string, unknown>;
    events(): RunnerEventNormalizer;
    cleanup(): Promise<void>;
}

export abstract class Runner {
    abstract readonly name: string;
    abstract readonly session: RunnerSessionAdapter;

    abstract prepare(
        workbench: ResolvedWorkbench,
        environment: Record<string, string | undefined>
    ): Promise<PreparedRunner>;
}

export function assertRunnerConfiguration(
    workbench: ResolvedWorkbench,
    configuration: ResolvedRunnerConfiguration
): void {
    if (configuration.runner !== workbench.manifest.runner) {
        throw new Error(
            `Effective runner ${configuration.runner} does not match Workbench runner ${workbench.manifest.runner}`
        );
    }
}
