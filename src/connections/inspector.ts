import {
    type AuthenticatedModelRoute,
    connectCommand,
    type ModelRoute,
    ModelRouter,
    type ResolvedRunnerConfiguration,
} from '../models/index.js';
import type { PreparedRunner } from '../runners/runner.js';
import type { PreparedRuntime } from '../runtimes/contracts.js';
import type { ResolvedWorkbench } from '../types.js';
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
    readonly #router = new ModelRouter();

    constructor(options: ConnectionInspectorOptions) {
        this.#workbench = options.workbench;
        this.#runtime = options.runtime;
        this.#runner = options.runner;
        this.#reference = options.reference ?? options.workbench.manifest.name;
        this.#store = options.store;
    }

    candidates(): AuthenticatedModelRoute[] {
        const routes = this.#router.routes(this.#workbench);
        if (this.#workbench.manifest.runner === 'opencode') {
            return routes.map((route) => ({
                provider: route.provider,
                nativeProvider: route.provider,
                nativeModel: route.model,
            }));
        }
        if (this.#workbench.manifest.runner === 'pi') {
            return uniqueAuthenticatedRoutes(routes.flatMap(piRouteCandidates));
        }
        return unsupportedRunner(this.#workbench.manifest.runner);
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
        const authenticatedRoutes =
            this.#workbench.manifest.runner === 'opencode'
                ? await inspectOpenCode(
                      nativeOptions,
                      routes,
                      this.#router,
                      discoveryPreference
                  )
                : this.#workbench.manifest.runner === 'pi'
                  ? await inspectPi(
                        nativeOptions,
                        routes,
                        this.#router,
                        discoveryPreference
                    )
                  : unsupportedRunner(this.#workbench.manifest.runner);
        const requested = options.connection
            ? requestedConnection(authenticatedRoutes, options.connection)
            : undefined;
        if (options.connection && !requested) {
            throw new Error(
                `Connection ${options.connection} is not authenticated for ${canonicalModel(this.#workbench)} with ${this.#workbench.manifest.runner} in the ${this.#runtime.name} runtime. Run ${connectCommand(this.#reference)}.`
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
            connectCommand: connectCommand(this.#reference),
            ...(selected ? { configuration } : {}),
        };
    }

    async require(connection?: string): Promise<ResolvedRunnerConfiguration> {
        const status = await this.inspect({
            ...(connection ? { discoverConnections: true } : {}),
            ...(connection ? { connection } : {}),
        });
        if (status.ready && status.configuration) return status.configuration;
        throw new Error(
            `No authenticated route is available for ${canonicalModel(this.#workbench)}. Run ${status.connectCommand}.`
        );
    }

    async connect(
        nativeProvider?: string,
        nativeMethod?: string,
        authenticationMethod?: string
    ): Promise<RunnerAuthenticationStatus> {
        const command = nativeConnectCommand(
            this.#workbench.manifest.runner,
            nativeProvider,
            nativeMethod
        );
        const invocation = this.#runner.native(this.#runtime, command);
        const code = await this.#runtime.interact(invocation);
        if (code !== 0) {
            throw new Error(
                `${runnerLabel(this.#workbench.manifest.runner)} authentication exited with code ${code}`
            );
        }
        const after = await this.inspect({ discoverConnections: true });
        if (!after.ready) {
            throw new Error(
                `${runnerLabel(this.#workbench.manifest.runner)} did not report an authenticated route for ${canonicalModel(this.#workbench)}`
            );
        }
        if (
            nativeProvider &&
            !after.connections.some(
                (connection) =>
                    connection.nativeProvider === nativeProvider &&
                    (!authenticationMethod ||
                        connection.authenticationMethod === authenticationMethod)
            )
        ) {
            throw new Error(
                `${runnerLabel(this.#workbench.manifest.runner)} did not report a compatible ${nativeProvider} connection for ${canonicalModel(this.#workbench)}`
            );
        }
        return after;
    }

    supportsNativeAuthentication(): boolean {
        return (
            this.#runtime.nativeAuthentication === 'persistent' &&
            ['opencode', 'pi'].includes(this.#workbench.manifest.runner)
        );
    }

    nativeAuthenticationError(): Error {
        if (this.#runtime.nativeAuthentication === 'unavailable') {
            return new Error(
                `${runnerLabel(this.#workbench.manifest.runner)} native authentication requires persistent credential storage in the ${this.#runtime.name} runtime`
            );
        }
        return nativeAuthenticationError(this.#workbench.manifest.runner);
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

async function inspectOpenCode(
    options: {
        workbench: ResolvedWorkbench;
        runtime: PreparedRuntime;
        runner: PreparedRunner;
        discoverConnections?: boolean;
    },
    routes: ModelRoute[],
    router: ModelRouter,
    preferredConnection?: RunnerConnectionSelection
): Promise<AuthenticatedModelRoute[]> {
    const environmentProviders = providersFromEnvironment(
        routes,
        options.runtime.environment,
        router
    );
    const configProviders = options.workbench.runnerConfigPath
        ? routes
              .filter((route) => !router.catalog.providers[route.provider])
              .map((route) => route.provider)
        : [];
    const directlyReady = new Set([...environmentProviders, ...configProviders]);
    const directRoutes = authenticatedRoutesForProviders(routes, directlyReady, 'api');
    if (
        !shouldInspectNativeConnections(
            options.discoverConnections ?? false,
            directRoutes,
            preferredConnection
        )
    ) {
        return directRoutes;
    }
    const base = options.runner.native(options.runtime, ['opencode', 'auth', 'list']);
    const result = await options.runtime
        .execute(base, {
            network: 'none',
            readOnly: true,
        })
        .catch((error) => {
            if (directlyReady.size > 0) return undefined;
            throw error;
        });
    if (!result) {
        return authenticatedRoutesForProviders(routes, directlyReady, 'api');
    }
    if (result.code !== 0) {
        if (directlyReady.size > 0) {
            return authenticatedRoutesForProviders(routes, directlyReady, 'api');
        }
        throw new Error(
            diagnostic(result, 'OpenCode credentials could not be inspected')
        );
    }
    const credentials = openCodeCredentials(result);
    return uniqueAuthenticatedRoutes([
        ...authenticatedRoutesForProviders(routes, directlyReady, 'api'),
        ...routes.flatMap((route) => {
            const method = credentials.get(normalizeProvider(route.provider));
            return method
                ? [
                      {
                          provider: route.provider,
                          nativeProvider: route.provider,
                          nativeModel: route.model,
                          authenticationMethod: method,
                      },
                  ]
                : [];
        }),
    ]);
}

async function inspectPi(
    options: {
        workbench: ResolvedWorkbench;
        runtime: PreparedRuntime;
        runner: PreparedRunner;
        discoverConnections?: boolean;
    },
    routes: ModelRoute[],
    router: ModelRouter,
    preferredConnection?: RunnerConnectionSelection
): Promise<AuthenticatedModelRoute[]> {
    const directRoutes = authenticatedRoutesForProviders(
        routes,
        new Set(providersFromEnvironment(routes, options.runtime.environment, router)),
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
    const base = options.runner.native(options.runtime, [
        'pi',
        '--offline',
        '--list-models',
    ]);
    const result = await options.runtime.execute(base, {
        network: 'none',
        readOnly: true,
    });
    if (result.code !== 0) {
        throw new Error(diagnostic(result, 'Pi credentials could not be inspected'));
    }
    const available = parsePiModels(`${result.stdout}\n${result.stderr}`);
    const nativeRoutes = routes.flatMap((route) =>
        piRouteCandidates(route).filter((candidate) =>
            available.has(`${candidate.nativeProvider}/${candidate.nativeModel}`)
        )
    );
    return uniqueAuthenticatedRoutes([...directRoutes, ...nativeRoutes]);
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

function piRouteCandidates(route: ModelRoute): AuthenticatedModelRoute[] {
    return [
        {
            provider: route.provider,
            nativeProvider: route.provider,
            nativeModel: route.model,
            authenticationMethod: 'api',
        },
        ...(route.provider === 'openai'
            ? [
                  {
                      provider: route.provider,
                      nativeProvider: 'openai-codex',
                      nativeModel: route.model,
                      authenticationMethod: 'oauth',
                  },
              ]
            : []),
    ];
}

function nativeConnectCommand(
    runner: string,
    provider?: string,
    method?: string
): string[] {
    if (runner === 'opencode') {
        return [
            'opencode',
            'auth',
            'login',
            ...(provider ? ['--provider', provider] : []),
            ...(method ? ['--method', method] : []),
        ];
    }
    if (runner === 'pi') {
        return ['pi', '--no-context-files'];
    }
    return unsupportedRunner(runner);
}

function nativeAuthenticationError(runner: string): Error {
    if (runner === 'pi') {
        return new Error('Pi native authentication is unavailable in this runtime');
    }
    return new Error(
        `${runnerLabel(runner)} does not expose a supported command-line login operation`
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

function openCodeCredentials(result: {
    stdout: string;
    stderr: string;
}): Map<string, string> {
    const credentials = new Map<string, string>();
    for (const line of `${result.stdout}\n${result.stderr}`
        .split(/\r?\n/)
        .map((line) => stripTerminalControl(line).trim())
        .filter((line) => line.startsWith('●'))) {
        const parts = line.slice(1).trim().split(/\s+/);
        const method = parts.pop()?.toLowerCase();
        const provider = normalizeProvider(parts.join(' '));
        if (provider && method) credentials.set(provider, method);
    }
    return credentials;
}

function parsePiModels(value: string): Set<string> {
    const models = new Set<string>();
    for (const line of stripTerminalControl(value).split(/\r?\n/)) {
        const [provider, model] = line.trim().split(/\s+/);
        if (!provider || !model || provider === 'provider') continue;
        if (!/^[a-z0-9][a-z0-9._-]*$/i.test(provider)) continue;
        if (!/^[a-z0-9][a-z0-9._:/-]*$/i.test(model)) continue;
        models.add(`${provider}/${model}`);
    }
    return models;
}

function normalizeProvider(value: string): string {
    return value.toLowerCase().replaceAll(/[^a-z0-9]/g, '');
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

function runnerLabel(runner: string): string {
    return runner === 'opencode' ? 'OpenCode' : runner === 'pi' ? 'Pi' : runner;
}

function unsupportedRunner(runner: string): never {
    throw new Error(`Unsupported runner: ${runner}`);
}
