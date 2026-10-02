import type { RunnerConnectionSelection } from '../connections/store.js';
import type { WorkbenchManifest, WorkbenchModelPolicy } from '../types.js';
import { modelLabel } from './label.js';
import type {
    ModelCatalogModel,
    ModelCatalogProvider,
    ModelCatalogSnapshot,
} from './snapshot.js';

export type ModelCatalogData = ModelCatalogSnapshot;
export type { ModelCatalogModel, ModelCatalogProvider };

/** The parts of a resolved Workbench that routing reads. */
export interface RoutedWorkbench {
    manifest: Pick<WorkbenchManifest, 'name' | 'runner' | 'model' | 'env'>;
    runnerConfigPath?: string;
}

export interface ModelRoute {
    provider: string;
    model: string;
    value: string;
}

export interface AuthenticatedModelRoute {
    provider: string;
    nativeProvider: string;
    nativeModel: string;
    authenticationMethod?: string;
}

export interface ResolvedRunnerConfiguration {
    runner: string;
    canonicalModel: string;
    model: string;
    provider: string;
    nativeProvider: string;
    nativeModel: string;
    routes: ModelRoute[];
    runnerConfigPath?: string;
    catalogVersion?: string;
}

export interface RouteConfigurationOptions {
    /** The manifest's `model` block. */
    model: WorkbenchModelPolicy;
    /**
     * Names of the environment variables the host can supply, never their
     * values. A route is usable when one of its provider's variables is named.
     */
    environmentNames: Iterable<string>;
    /** The route to use. Without it, the first usable route in manifest order. */
    provider?: string;
    /** The Workbench name, used in messages. */
    name?: string;
    /** Packaged runner configuration. Models the catalog does not know require it. */
    runnerConfigPath?: string;
}

export interface ResolveModelRouteOptions {
    workbench: RoutedWorkbench;
    authenticatedProviders?: Iterable<string>;
    authenticatedRoutes?: Iterable<AuthenticatedModelRoute>;
    preferredConnection?: RunnerConnectionSelection;
    requireAuthentication?: boolean;
}

export class ModelRouter {
    /** Routes against `catalog`, the snapshot the caller loaded or was given. */
    constructor(readonly catalog: ModelCatalogSnapshot) {}

    routes(workbench: RoutedWorkbench): ModelRoute[] {
        const declared = workbench.manifest.model;
        const knownModel = Boolean(this.catalog.models[declared.id]);
        if (!knownModel) {
            const explicit = declared.routes?.every((route) => route.model);
            if (!explicit || !workbench.runnerConfigPath) {
                throw new Error(
                    `Unknown model ${declared.id}. Unknown models require explicit route model IDs and packaged runner_config.`
                );
            }
        }

        const routes = declared.routes
            ? declared.routes.map((route) => ({
                  provider: route.provider,
                  model: route.model ?? this.providerModel(declared.id, route.provider),
              }))
            : this.inferredRoutes(declared.id);
        if (routes.length === 0) {
            throw new Error(`No provider route is available for model ${declared.id}`);
        }
        return routes.map((route) => ({
            ...route,
            value: `${route.provider}/${route.model}`,
        }));
    }

    resolve(options: ResolveModelRouteOptions): ResolvedRunnerConfiguration {
        const routes = this.routes(options.workbench);
        const authenticated = new Set(options.authenticatedProviders ?? []);
        const authenticatedRoutes = [...(options.authenticatedRoutes ?? [])];
        const preferredAuthentication = options.preferredConnection
            ? authenticatedRoutes.find(
                  (candidate) =>
                      candidate.provider === options.preferredConnection?.provider &&
                      candidate.nativeProvider ===
                          options.preferredConnection.nativeProvider &&
                      (!options.preferredConnection.authenticationMethod ||
                          candidate.authenticationMethod ===
                              options.preferredConnection.authenticationMethod)
              )
            : undefined;
        const selectedRoute = preferredAuthentication
            ? routes.find(
                  (route) => route.provider === preferredAuthentication.provider
              )
            : routes.find((route) =>
                  authenticatedRoutes.some(
                      (candidate) => candidate.provider === route.provider
                  )
              );
        const selectedAuthentication = selectedRoute
            ? (preferredAuthentication ??
              authenticatedRoutes.find(
                  (candidate) => candidate.provider === selectedRoute.provider
              ))
            : undefined;
        const selected =
            selectedRoute ??
            routes.find((route) => authenticated.has(route.provider)) ??
            (options.requireAuthentication ? undefined : routes[0]);
        if (!selected) {
            throw new Error(
                `No authenticated route is available for ${modelLabel(options.workbench.manifest.model)}. Run ${connectCommand(options.workbench.manifest.name)}.`
            );
        }
        const nativeProvider =
            selectedAuthentication?.nativeProvider ?? selected.provider;
        const nativeModel = selectedAuthentication?.nativeModel ?? selected.model;
        return {
            runner: options.workbench.manifest.runner,
            canonicalModel: modelLabel(options.workbench.manifest.model),
            model: `${nativeProvider}/${nativeModel}`,
            provider: selected.provider,
            nativeProvider,
            nativeModel,
            routes,
            ...(options.workbench.runnerConfigPath
                ? { runnerConfigPath: options.workbench.runnerConfigPath }
                : {}),
            catalogVersion: this.catalog.version,
        };
    }

    /**
     * Builds the OpenCode runner configuration for a chosen provider route, the
     * same configuration `wb run --connection <provider>` resolves. It reads only
     * its arguments and this router's catalog. It does not inspect the machine or
     * any stored connection, so a host states which credentials it holds by
     * naming their environment variables.
     */
    configureOpenCode(options: RouteConfigurationOptions): ResolvedRunnerConfiguration {
        const workbench: RoutedWorkbench = {
            manifest: {
                name: options.name ?? options.model.id,
                runner: 'opencode',
                model: options.model,
                env: {},
            },
            ...(options.runnerConfigPath
                ? { runnerConfigPath: options.runnerConfigPath }
                : {}),
        };
        const routes = this.routes(workbench);
        const available = new Set(options.environmentNames);
        const ready = (provider: string): boolean => {
            const names = this.catalog.providers[provider]?.env;
            // A provider the catalog does not list is configured by packaged runner config.
            return names === undefined || names.some((name) => available.has(name));
        };
        const route = options.provider
            ? routes.find((candidate) => candidate.provider === options.provider)
            : routes.find((candidate) => ready(candidate.provider));
        if (!route) {
            throw new Error(
                options.provider
                    ? `${options.model.id} has no route through ${options.provider}. Its routes are ${routes.map((candidate) => candidate.provider).join(', ')}.`
                    : `No route for ${options.model.id} has credentials in the named environment.`
            );
        }
        if (!ready(route.provider)) {
            const names = this.catalog.providers[route.provider]?.env ?? [];
            throw new Error(
                `The ${route.provider} route needs one of these environment variables: ${names.join(', ')}.`
            );
        }
        return this.resolve({
            workbench,
            authenticatedRoutes: [
                {
                    provider: route.provider,
                    nativeProvider: route.provider,
                    nativeModel: route.model,
                },
            ],
            preferredConnection: {
                provider: route.provider,
                nativeProvider: route.provider,
            },
            requireAuthentication: true,
        });
    }

    providerEnvironmentNames(workbench: RoutedWorkbench): string[] {
        return [
            ...new Set(
                this.routes(workbench).flatMap(
                    (route) => this.catalog.providers[route.provider]?.env ?? []
                )
            ),
        ].toSorted();
    }

    environmentForRoute(
        workbench: RoutedWorkbench,
        configuration: ResolvedRunnerConfiguration,
        environment: Record<string, string | undefined>
    ): Record<string, string | undefined> {
        const selected = new Set(
            this.catalog.providers[configuration.provider]?.env ?? []
        );
        const declared = new Set(Object.keys(workbench.manifest.env));
        const providerEnvironment = new Set(
            Object.values(this.catalog.providers).flatMap((provider) => provider.env)
        );
        return Object.fromEntries(
            Object.entries(environment).filter(
                ([name]) =>
                    !providerEnvironment.has(name) ||
                    selected.has(name) ||
                    declared.has(name)
            )
        );
    }

    private inferredRoutes(id: string): ModelRoute[] {
        const slash = id.indexOf('/');
        const lab = id.slice(0, slash);
        return Object.entries(this.catalog.models[id]?.routes ?? {})
            .toSorted(([left], [right]) => {
                if (left === lab) return -1;
                if (right === lab) return 1;
                return left.localeCompare(right);
            })
            .map(([provider, model]) => ({
                provider,
                model,
                value: `${provider}/${model}`,
            }));
    }

    private providerModel(id: string, provider: string): string {
        const slash = id.indexOf('/');
        if (slash <= 0) throw new Error(`Invalid canonical model: ${id}`);
        if (!this.catalog.providers[provider]) {
            throw new Error(`Unknown model provider: ${provider}`);
        }
        const model = this.catalog.models[id]?.routes[provider];
        if (model) return model;
        throw new Error(`Provider ${provider} does not serve model ${id}`);
    }
}

export function connectCommand(reference: string): string {
    return `wb connect ${shellWord(reference)}`;
}

function shellWord(value: string): string {
    return /^[A-Za-z0-9_./:@#-]+$/.test(value)
        ? value
        : `'${value.replaceAll("'", `'\\''`)}'`;
}
