import type {
    ConnectionAuthenticationMethod,
    ConnectionRuntime,
} from '../connections/contracts.js';
import type { RunnerConnectionSelection } from '../connections/store.js';
import type {
    AuthenticatedModelRoute,
    ModelCatalogHarnessProviderRoute,
    ModelCatalogSnapshot,
    ModelRoute,
    ResolvedRunnerConfiguration,
} from '../models/index.js';
import type { WorkbenchEventDraft } from '../runs/events.js';
import type {
    PreparedRuntime,
    RuntimeAsset,
    RuntimeRunnerContract,
} from '../runtimes/contracts.js';
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
    startSession(
        runtime: PreparedRuntime,
        options: PreparedRunnerSessionOptions
    ): Promise<RunnerSession>;
    cleanup(): Promise<void>;
}

export interface PreparedRunnerSessionOptions {
    configuration: ResolvedRunnerConfiguration;
    host: RunnerSessionHost;
    session?: RunnerSessionContext;
    authentication?: RunnerConnectionSelection;
}

/** The native credential file a runner reads inside a credential root. */
export interface RunnerCredentials {
    /** The file's path relative to the credential root. */
    file: string;
    /** The entry type an API key is stored as. */
    apiKeyEntryType: string;
    /** The harness reads a stored entry before provider variables, so the entry decides alone. */
    storeFirst: boolean;
    /** The environment that points the harness at a mounted credential root. */
    environment(root: string): Record<string, string>;
}

/** A login the harness CLI runs on the host. Its files go where `credentials.environment` points. */
export interface RunnerHostSignIn {
    /** The harness CLI to find on the host. */
    executable: string;
    /** The login arguments for one native provider and, when given, its native method. */
    arguments(nativeProvider: string, nativeMethod?: string): string[];
}

/** How a runner lists the credentials it holds inside a runtime. */
export interface RunnerCredentialProbe {
    /** The native command that lists them. It runs read-only without network. */
    command: string[];
    /** A failed listing fails inspection even when other routes are ready directly. */
    failsClosed: boolean;
    /** The candidates the listing authenticates. The listing is its output with terminal control removed. */
    authenticated(
        listing: string,
        candidates: AuthenticatedModelRoute[]
    ): AuthenticatedModelRoute[];
}

/** How `wb connect` and credential inspection reach a runner's model providers. */
export type RunnerConnection = RunnerProviderAccess & RunnerSignIn;

/**
 * How a subscription is signed in: a command-line login on the host, or, for a
 * runner without one, what the user does in the runner itself.
 */
export type RunnerSignIn =
    | { hostSignIn: RunnerHostSignIn; manualSignIn?: never }
    | { hostSignIn?: never; manualSignIn: string };

/** The providers a runner reaches, and how it reports and finishes their sign-in. */
export interface RunnerProviderAccess {
    /** The runner's provider capabilities from the catalog, or its built-in ones. */
    capabilities(
        catalog: ModelCatalogSnapshot
    ): Record<string, ModelCatalogHarnessProviderRoute[]>;
    /** The native connections a manifest route can use. */
    candidates(
        route: ModelRoute,
        catalog: ModelCatalogSnapshot
    ): AuthenticatedModelRoute[];
    /** A packaged runner config can define providers the catalog lacks, which are then ready directly. */
    packagedProviders: boolean;
    probe: RunnerCredentialProbe;
    /** A provider's methods when the runner offers its own. Undefined uses the generic capability mapping. */
    methods(
        runtime: ConnectionRuntime,
        provider: string,
        catalog: ModelCatalogSnapshot
    ): ConnectionAuthenticationMethod[] | undefined;
    /** A first-run provider sign-in can finish inside a Workbench run. */
    inRunSignIn: boolean;
}

export abstract class Runner {
    abstract readonly name: string;
    /** The harness name as people read it. */
    abstract readonly displayName: string;
    abstract readonly session: RunnerSessionAdapter;
    /** The shape a package's `runner_config` must have: a file, a directory, or either. */
    abstract readonly runnerConfig: 'file' | 'directory' | 'either';
    /** The harness holds its session open over piped standard input. */
    abstract readonly standardInput: boolean;
    /** The runner's native credential file. Without it Workbench keeps no credentials for it. */
    readonly credentials?: RunnerCredentials | undefined;
    /** How `wb connect`, runs, `view` and `smoke` reach the runner's model providers. */
    abstract readonly connection: RunnerConnection;

    abstract prepare(
        workbench: ResolvedWorkbench,
        environment: Record<string, string | undefined>
    ): Promise<PreparedRunner>;

    /** What a runtime needs to know to launch this runner. */
    runtimeContract(): RuntimeRunnerContract {
        const credentials = this.credentials;
        return {
            standardInput: this.standardInput,
            ...(credentials
                ? {
                      credentialEnvironment: (root: string) =>
                          credentials.environment(root),
                  }
                : {}),
        };
    }
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
