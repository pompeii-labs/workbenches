import type { RunnerConnectionSelection } from '../connections/store.js';
import type {
    AuthenticatedModelRoute,
    ModelCatalogHarnessProviderRoute,
    ModelCatalogSnapshot,
    ModelRoute,
    ResolvedRunnerConfiguration,
} from '../models/index.js';
import type { WorkbenchEventDraft } from '../runs/events.js';
import type { PreparedRuntime, RuntimeAsset } from '../runtimes/contracts.js';
import type { ResolvedWorkbench, RunnerInvocation } from '../types.js';
import type {
    RunnerSession,
    RunnerSessionAdapter,
    RunnerSessionContext,
    RunnerSessionHost,
} from './session.js';

export interface RunnerSummary {
    finalText: string;
    turnCompleted: boolean;
    completionReason?: string;
    failureMessage?: string;
}

export interface RunnerEventNormalizer {
    consume(value: unknown): { events: WorkbenchEventDraft[] };
    summary(): RunnerSummary;
}

export interface RunnerAuthentication {
    environmentNames: readonly string[];
    providerCapabilities(
        catalog: ModelCatalogSnapshot
    ): Record<string, ModelCatalogHarnessProviderRoute[]>;
    allowEnvironment(name: string, runtime: string): boolean;
    nativeCredentialStore(runtime: string): boolean;
    inRunAuthentication: boolean;
    credentialFormat?: 'provider';
    supportsNativeAuthentication(
        runtime: string,
        provider: string,
        method: string
    ): boolean;
    localAdvice(provider: string): string;
    loginArguments?(provider: string, method: string): string[];
    invocationEnvironment?(
        runtime: string,
        environment: Record<string, string | undefined>
    ): Record<string, string | undefined>;
    hostEnvironment?(
        runtime: string,
        environment: Record<string, string | undefined>
    ): Record<string, string | undefined>;
    credentialEnvironment?(credentialRoot: string): Record<string, string | undefined>;
    subprocessEnvironmentScrubbing?: {
        macos: boolean;
        linuxProbe: string[];
    };
    runnerConfigShape?: 'file' | 'directory';
}

export interface PreparedRunner {
    readonly name: string;
    readonly nativeCommand?: string;
    readonly nativeVersion?: { minimum: string };
    readonly permissions?: { allow: string[]; deny: string[] };
    readonly warnings?: string[];
    readonly failureLabel: string;
    readonly assets: RuntimeAsset[];
    readonly stateOverlay?: string[];
    readonly authentication?: RunnerAuthentication;
    connectionCandidates?(route: ModelRoute): AuthenticatedModelRoute[];
    inspectNativeConnections?(
        runtime: PreparedRuntime
    ): Promise<AuthenticatedModelRoute[]>;
    configureRuntime?(runtime: PreparedRuntime): Promise<void>;
    build(
        runtime: PreparedRuntime,
        task: string,
        configuration: ResolvedRunnerConfiguration
    ): RunnerInvocation;
    native(runtime: PreparedRuntime, command: string[]): RunnerInvocation;
    publicInvocation(invocation: RunnerInvocation): Record<string, unknown>;
    events(): RunnerEventNormalizer;
    startSession(
        runtime: PreparedRuntime,
        options: PreparedRunnerSessionOptions
    ): Promise<RunnerSession>;
    cleanup(): Promise<void>;
}

export interface PreparedRunnerSessionOptions {
    configuration: ResolvedRunnerConfiguration;
    host: RunnerSessionHost;
    answerRequests?: boolean;
    session?: RunnerSessionContext;
    authentication?: RunnerConnectionSelection;
}

export interface RunnerPrepareOptions {
    session?: RunnerSessionContext;
    workspaceDirectory?: string;
    includeRuntimeDirectories?: boolean;
}

export abstract class Runner {
    abstract readonly name: string;
    get displayName(): string {
        return this.name;
    }
    abstract readonly session: RunnerSessionAdapter;
    readonly authentication?: RunnerAuthentication;

    abstract prepare(
        workbench: ResolvedWorkbench,
        environment: Record<string, string | undefined>,
        options?: RunnerPrepareOptions
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
