import {
    ActiveModelCatalog,
    type AuthenticatedModelRoute,
    connectAdvice,
    connectCommand,
    type ModelRoute,
    ModelRouter,
    type ResolvedRunnerConfiguration,
} from '../models/index.js';
import { RunnerRegistry } from '../runners/registry.js';
import type { PreparedRunner, Runner, RunnerConnection } from '../runners/runner.js';
import type { PreparedRuntime } from '../runtimes/contracts.js';
import type { ResolvedWorkbench } from '../types.js';
import { AuthenticationRequiredError } from './error.js';
import { ConnectionStore, type RunnerConnectionSelection } from './store.js';

export interface RunnerAuthenticationStatus {
    model: string;
    ready: boolean;
    authenticatedProviders: string[];
    connections: AuthenticatedModelRoute[];
    routes: Array<
        ModelRoute & {
            authenticated: boolean;
            nativeProvider?: string;
            nativeModel?: string;
        }
    >;
    connectCommand: string;
    configuration?: ResolvedRunnerConfiguration;
}

export interface ConnectionInspectorOptions {
    workbench: ResolvedWorkbench;
    runtime: PreparedRuntime;
    runner: PreparedRunner;
    reference?: string;
    store?: ConnectionStore;
    /** The runners the Workbench's runner is resolved from. */
    runners?: Pick<RunnerRegistry, 'resolve'>;
}

export interface InspectConnectionOptions {
    preferredConnection?: RunnerConnectionSelection;
    connection?: string;
    discoverConnections?: boolean;
}

export class ConnectionInspector {
    readonly #workbench: ResolvedWorkbench;
    readonly #runtime: PreparedRuntime;
    readonly #runner: PreparedRunner;
    readonly #reference: string;
    readonly #store: ConnectionStore | undefined;
    readonly #router = new ModelRouter(ActiveModelCatalog.current());
    readonly #runners: Pick<RunnerRegistry, 'resolve'>;

    constructor(options: ConnectionInspectorOptions) {
        this.#workbench = options.workbench;
        this.#runtime = options.runtime;
        this.#runner = options.runner;
        this.#reference = options.reference ?? options.workbench.manifest.name;
        this.#store = options.store;
        this.#runners = options.runners ?? RunnerRegistry.standard();
    }

    candidates(): AuthenticatedModelRoute[] {
        const routes = this.#router.routes(this.#workbench);
        return uniqueAuthenticatedRoutes(
            nativeCandidates(this.#harness().connection, routes, this.#router)
        );
    }

    /** The registered runner the Workbench names. */
    #harness(): Runner {
        return this.#runners.resolve(this.#workbench.manifest.runner);
    }

    async inspect(
        options: InspectConnectionOptions = {}
    ): Promise<RunnerAuthenticationStatus> {
        const context = ConnectionStore.context(this.#workbench);
        const storedPreference =
            options.preferredConnection ?? (await this.#store?.find(context));
        const discoveryPreference = options.connection
            ? { provider: options.connection, nativeProvider: options.connection }
            : storedPreference;
        const routes = this.#router.routes(this.#workbench);
        const nativeOptions = {
            workbench: this.#workbench,
            runtime: this.#runtime,
            runner: this.#runner,
            ...(options.discoverConnections !== undefined
                ? { discoverConnections: options.discoverConnections }
                : {}),
        };
        const authenticatedRoutes = await inspectNative(
            nativeOptions,
            this.#harness(),
            routes,
            this.#router,
            discoveryPreference
        );
        const requested = options.connection
            ? requestedConnection(authenticatedRoutes, options.connection)
            : undefined;
        if (options.connection && !requested) {
            throw new AuthenticationRequiredError(
                `Connection ${options.connection} is not authenticated for ${canonicalModel(this.#workbench)} with ${this.#workbench.manifest.runner} in the ${this.#runtime.name} runtime. ${connectAdvice(this.#connectCommand())}.`
            );
        }
        const preferredConnection = requested ?? storedPreference;
        const authenticatedProviders = [
            ...new Set(authenticatedRoutes.map((route) => route.provider)),
        ].toSorted();
        const configuration = this.#router.resolve({
            workbench: this.#workbench,
            authenticatedRoutes,
            ...(preferredConnection ? { preferredConnection } : {}),
            requireAuthentication: false,
        });
        const selected = authenticatedRoutes.length > 0;
        return {
            model: canonicalModel(this.#workbench),
            ready: selected,
            authenticatedProviders,
            connections: authenticatedRoutes,
            routes: routes.map((route) => {
                const match = authenticatedRoutes.find(
                    (candidate) => candidate.provider === route.provider
                );
                return {
                    ...route,
                    authenticated: Boolean(match),
                    ...(match
                        ? {
                              nativeProvider: match.nativeProvider,
                              nativeModel: match.nativeModel,
                          }
                        : {}),
                };
            }),
            connectCommand: this.#connectCommand(),
            ...(selected ? { configuration } : {}),
        };
    }

    async require(connection?: string): Promise<ResolvedRunnerConfiguration> {
        const status = await this.inspect({
            ...(connection ? { discoverConnections: true } : {}),
            ...(connection ? { connection } : {}),
        });
        if (status.ready && status.configuration) return status.configuration;
        throw new AuthenticationRequiredError(
            `No authenticated route is available for ${canonicalModel(this.#workbench)}. ${connectAdvice(status.connectCommand)}.`
        );
    }

    #connectCommand(): string {
        return connectCommand(this.#reference, this.#runtime.name);
    }

    configurationFor(
        selection: RunnerConnectionSelection
    ): ResolvedRunnerConfiguration {
        const candidate = this.candidates().find(
            (route) =>
                route.provider === selection.provider &&
                route.nativeProvider === selection.nativeProvider
        );
        if (!candidate) {
            throw new Error(
                `The configured ${selection.nativeProvider} connection is incompatible with ${canonicalModel(this.#workbench)}`
            );
        }
        const route = {
            ...candidate,
            ...(selection.authenticationMethod
                ? { authenticationMethod: selection.authenticationMethod }
                : {}),
        };
        return this.#router.resolve({
            workbench: this.#workbench,
            authenticatedRoutes: [route],
            preferredConnection: selection,
        });
    }
}

function requestedConnection(
    connections: AuthenticatedModelRoute[],
    requested: string
): RunnerConnectionSelection | undefined {
    const name = requested.trim().toLowerCase();
    if (!name) return undefined;
    const native = connections.find(
        (connection) => connection.nativeProvider.toLowerCase() === name
    );
    if (native) {
        return {
            provider: native.provider,
            nativeProvider: native.nativeProvider,
            ...(native.authenticationMethod
                ? { authenticationMethod: native.authenticationMethod }
                : {}),
        };
    }
    const provider = connections.find(
        (connection) => connection.provider.toLowerCase() === name
    );
    return provider
        ? {
              provider: provider.provider,
              nativeProvider: provider.nativeProvider,
              ...(provider.authenticationMethod
                  ? { authenticationMethod: provider.authenticationMethod }
                  : {}),
          }
        : undefined;
}

/**
 * Routes ready from provider variables, or from a packaged runner config that
 * defines its own providers, plus the routes the runner's credential listing
 * authenticates. The listing runs only when direct routes do not settle it.
 */
async function inspectNative(
    options: {
        workbench: ResolvedWorkbench;
        runtime: PreparedRuntime;
        runner: PreparedRunner;
        discoverConnections?: boolean;
    },
    harness: Runner,
    routes: ModelRoute[],
    router: ModelRouter,
    preferredConnection?: RunnerConnectionSelection
): Promise<AuthenticatedModelRoute[]> {
    const { connection } = harness;
    const environmentProviders = providersFromEnvironment(
        routes,
        options.runtime.environment,
        router
    );
    const packagedProviders =
        connection.packagedProviders && options.workbench.runnerConfigPath
            ? routes
                  .filter((route) => !router.catalog.providers[route.provider])
                  .map((route) => route.provider)
            : [];
    const directRoutes = authenticatedRoutesForProviders(
        routes,
        new Set([...environmentProviders, ...packagedProviders]),
        'api'
    );
    if (
        !shouldInspectNativeConnections(
            options.discoverConnections ?? false,
            directRoutes,
            preferredConnection
        )
    ) {
        return directRoutes;
    }
    // Unless the listing fails closed, ready direct routes stand when it fails.
    const directRoutesStand = !connection.probe.failsClosed && directRoutes.length > 0;
    const base = options.runner.native(
        options.runtime,
        connection.probe.commandFor?.(options.runtime.workspaceDirectory) ??
            connection.probe.command
    );
    const result = await options.runtime
        .execute(base, {
            network: 'none',
            readOnly: true,
        })
        .catch((error) => {
            if (directRoutesStand) return undefined;
            throw error;
        });
    if (!result) return directRoutes;
    if (result.code !== 0) {
        if (directRoutesStand) return directRoutes;
        throw new Error(
            diagnostic(
                result,
                `${harness.displayName} credentials could not be inspected`
            )
        );
    }
    return uniqueAuthenticatedRoutes([
        ...directRoutes,
        ...connection.probe.authenticated(
            stripTerminalControl(`${result.stdout}\n${result.stderr}`),
            nativeCandidates(connection, routes, router)
        ),
    ]);
}

function nativeCandidates(
    connection: RunnerConnection,
    routes: ModelRoute[],
    router: ModelRouter
): AuthenticatedModelRoute[] {
    return routes.flatMap((route) => connection.candidates(route, router.catalog));
}

function shouldInspectNativeConnections(
    discoverConnections: boolean,
    directRoutes: AuthenticatedModelRoute[],
    preferredConnection?: RunnerConnectionSelection
): boolean {
    if (discoverConnections || directRoutes.length === 0) return true;
    if (!preferredConnection) return false;
    return !directRoutes.some(
        (route) =>
            route.provider === preferredConnection.provider &&
            route.nativeProvider === preferredConnection.nativeProvider &&
            (!preferredConnection.authenticationMethod ||
                route.authenticationMethod === preferredConnection.authenticationMethod)
    );
}

function uniqueAuthenticatedRoutes(
    routes: AuthenticatedModelRoute[]
): AuthenticatedModelRoute[] {
    return routes.filter(
        (route, index) =>
            routes.findIndex(
                (candidate) =>
                    candidate.provider === route.provider &&
                    candidate.nativeProvider === route.nativeProvider &&
                    candidate.nativeModel === route.nativeModel &&
                    candidate.authenticationMethod === route.authenticationMethod
            ) === index
    );
}

function authenticatedRoutesForProviders(
    routes: ModelRoute[],
    providers: Set<string>,
    authenticationMethod?: string
): AuthenticatedModelRoute[] {
    return routes.flatMap((route) =>
        providers.has(route.provider)
            ? [
                  {
                      provider: route.provider,
                      nativeProvider: route.provider,
                      nativeModel: route.model,
                      ...(authenticationMethod ? { authenticationMethod } : {}),
                  },
              ]
            : []
    );
}

function providersFromEnvironment(
    routes: ModelRoute[],
    environment: Record<string, string | undefined>,
    router: ModelRouter
): string[] {
    return routes.flatMap((route) => {
        const names = router.catalog.providers[route.provider]?.env ?? [];
        return names.some((name) => Boolean(environment[name]?.trim()))
            ? [route.provider]
            : [];
    });
}

function stripTerminalControl(value: string): string {
    // biome-ignore lint/complexity/useRegexLiterals: the literal form trips the control-character safeguard.
    return value.replaceAll(new RegExp(String.raw`\u001b\[[0-?]*[ -/]*[@-~]`, 'g'), '');
}

function diagnostic(
    result: { stdout: string; stderr: string },
    fallback: string
): string {
    const detail = `${result.stderr}\n${result.stdout}`
        .split(/\r?\n/)
        .map((line) => stripTerminalControl(line).trim())
        .find(Boolean);
    return detail ? `${fallback}: ${detail.slice(0, 500)}` : fallback;
}

function canonicalModel(workbench: ResolvedWorkbench): string {
    return workbench.manifest.model.id;
}
