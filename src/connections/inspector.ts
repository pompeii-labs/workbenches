import {
    ActiveModelCatalog,
    type AuthenticatedModelRoute,
    connectAdvice,
    connectCommand,
    type ModelRoute,
    ModelRouter,
    type ResolvedRunnerConfiguration,
} from '../models/index.js';
import { piRouteCandidates } from '../runners/pi/providers.js';
import type { PreparedRunner } from '../runners/runner.js';
import type { PreparedRuntime } from '../runtimes/contracts.js';
import type { ResolvedWorkbench } from '../types.js';
import { hasSavedProviderCredential } from './environmentcredentials.js';
import { AuthenticationRequiredError } from './error.js';
import { ConnectionStore, type RunnerConnectionSelection } from './store.js';
import { connectionProviderCapabilities } from './targets.js';

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
    instruction?: string;
    configuration?: ResolvedRunnerConfiguration;
    method?: string;
    warning?: string;
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
    readonly #router = new ModelRouter(ActiveModelCatalog.current());

    constructor(options: ConnectionInspectorOptions) {
        this.#workbench = options.workbench;
        this.#runtime = options.runtime;
        this.#runner = options.runner;
        this.#reference = options.reference ?? options.workbench.manifest.name;
        this.#store = options.store;
    }

    candidates(): AuthenticatedModelRoute[] {
        const routes = this.#router.routes(this.#workbench);
        if (!this.#runner.connectionCandidates) {
            if (this.#workbench.manifest.runner === 'opencode') {
                return routes.map((route) => ({
                    provider: route.provider,
                    nativeProvider: route.provider,
                    nativeModel: route.model,
                }));
            }
            if (this.#workbench.manifest.runner === 'pi') {
                const capabilities = connectionProviderCapabilities(
                    'pi',
                    this.#router.catalog
                );
                return uniqueAuthenticatedRoutes(
                    routes.flatMap((route) => piRouteCandidates(route, capabilities))
                );
            }
        }
        return uniqueAuthenticatedRoutes(
            routes.flatMap(
                (route) =>
                    this.#runner.connectionCandidates?.(route) ?? [
                        {
                            provider: route.provider,
                            nativeProvider: route.provider,
                            nativeModel: route.model,
                        },
                    ]
            )
        );
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
        const directlyReady = new Set(
            providersFromEnvironment(routes, this.#runtime.environment, this.#router)
        );
        if (this.#workbench.runnerConfigPath) {
            for (const route of routes) {
                if (!this.#router.catalog.providers[route.provider]) {
                    directlyReady.add(route.provider);
                }
            }
        }
        const directRoutes = this.candidates().flatMap((candidate) =>
            directlyReady.has(candidate.provider)
                ? [{ ...candidate, authenticationMethod: 'api' }]
                : []
        );
        const inspectNative = this.#runner.inspectNativeConnections
            ? () => this.#runner.inspectNativeConnections?.(this.#runtime) ?? []
            : () => this.#inspectLegacyNativeConnections(routes);
        const authenticatedRoutes = shouldInspectNativeConnections(
            options.discoverConnections ?? false,
            directRoutes,
            discoveryPreference
        )
            ? uniqueAuthenticatedRoutes([
                  ...directRoutes,
                  ...(await Promise.resolve(inspectNative()).catch((error) => {
                      if (directRoutes.length > 0) return [];
                      throw error;
                  })),
              ])
            : directRoutes;
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
        const selectedAuthentication = configuration
            ? authenticatedRoutes.find(
                  (route) =>
                      route.provider === configuration.provider &&
                      route.nativeProvider === configuration.nativeProvider &&
                      (!configuration.authenticationMethod ||
                          route.authenticationMethod ===
                              configuration.authenticationMethod)
              )
            : undefined;
        const warning = configuration
            ? billingWarning(
                  configuration.provider,
                  selectedAuthentication?.authenticationMethod,
                  this.#runtime.environment,
                  hasSavedProviderCredential(
                      this.#runtime.environment,
                      configuration.provider
                  ),
                  this.#connectCommand()
              )
            : undefined;
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
            ...(selectedAuthentication?.authenticationMethod
                ? { method: selectedAuthentication.authenticationMethod }
                : {}),
            ...(warning ? { warning } : {}),
        };
    }

    async #inspectLegacyNativeConnections(
        routes: ModelRoute[]
    ): Promise<AuthenticatedModelRoute[]> {
        if (this.#workbench.manifest.runner === 'opencode') {
            const result = await this.#runtime.execute(
                this.#runner.native(this.#runtime, ['opencode', 'auth', 'list']),
                { network: 'none', readOnly: true }
            );
            if (result.code !== 0) {
                throw new Error(
                    diagnostic(result, 'OpenCode credentials could not be inspected')
                );
            }
            const credentials = openCodeCredentials(result);
            return routes.flatMap((route) => {
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
            });
        }
        if (this.#workbench.manifest.runner === 'pi') {
            const result = await this.#runtime.execute(
                this.#runner.native(this.#runtime, [
                    'pi',
                    '--offline',
                    '--list-models',
                ]),
                { network: 'none', readOnly: true }
            );
            if (result.code !== 0) {
                throw new Error(
                    diagnostic(result, 'Pi credentials could not be inspected')
                );
            }
            const available = parsePiModels(`${result.stdout}\n${result.stderr}`);
            const capabilities = connectionProviderCapabilities(
                'pi',
                this.#router.catalog
            );
            return routes.flatMap((route) =>
                piRouteCandidates(route, capabilities).filter((candidate) =>
                    available.has(
                        `${candidate.nativeProvider}/${candidate.nativeModel}`
                    )
                )
            );
        }
        return [];
    }

    async require(connection?: string): Promise<ResolvedRunnerConfiguration> {
        const status = await this.inspect({
            ...(connection ? { discoverConnections: true } : {}),
            ...(connection ? { connection } : {}),
        });
        if (status.ready && status.configuration) return status.configuration;
        throw new AuthenticationRequiredError(
            `No authenticated route is available for ${canonicalModel(this.#workbench)}. ${status.instruction ?? connectAdvice(status.connectCommand)}.`
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

function billingWarning(
    provider: string,
    method: string | undefined,
    environment: Record<string, string | undefined>,
    saved: boolean,
    command: string
): string | undefined {
    if (method !== 'api') return undefined;
    const variable = ActiveModelCatalog.current().providers[provider]?.env.find(
        (name) => environment[name]?.trim()
    );
    if (variable) {
        return `${variable} is used and billed. To stop using it, unset ${variable}.`;
    }
    return saved
        ? `Saved credentials for ${provider} are used and billed. To stop using them, run ${command} --provider ${provider} --remove --method api-key.`
        : undefined;
}

function canonicalModel(workbench: ResolvedWorkbench): string {
    return workbench.manifest.model.id;
}
