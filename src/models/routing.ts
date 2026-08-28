import type { RunnerConnectionSelection } from '../connections/store.js';
import type { ResolvedWorkbench, WorkbenchModelPolicy } from '../types.js';
import {
    ModelCatalog,
    type ModelCatalogModel,
    type ModelCatalogProvider,
    type ModelCatalogSnapshot,
} from './catalog.js';

export type ModelCatalogData = ModelCatalogSnapshot;
export type { ModelCatalogModel, ModelCatalogProvider };

export interface ModelRoute {
    provider: string;
    model: string;
    value: string;
}

export interface AuthenticatedModelRoute {
    provider: string;
    nativeProvider: string;
    nativeModel: string;
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

export interface ResolveModelRouteOptions {
    workbench: ResolvedWorkbench;
    authenticatedProviders?: Iterable<string>;
    authenticatedRoutes?: Iterable<AuthenticatedModelRoute>;
    preferredConnection?: RunnerConnectionSelection;
    requireAuthentication?: boolean;
}

export class ModelRouter {
    constructor(readonly catalog: ModelCatalogSnapshot = ModelCatalog.current()) {}

    routes(workbench: ResolvedWorkbench): ModelRoute[] {
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
                          options.preferredConnection.nativeProvider
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

    providerEnvironmentNames(workbench: ResolvedWorkbench): string[] {
        return [
            ...new Set(
                this.routes(workbench).flatMap(
                    (route) => this.catalog.providers[route.provider]?.env ?? []
                )
            ),
        ].toSorted();
    }

    environmentForRoute(
        workbench: ResolvedWorkbench,
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

export function modelLabel(model: WorkbenchModelPolicy): string {
    return model.id;
}

export function connectCommand(reference: string): string {
    return `wb connect ${shellWord(reference)}`;
}

function shellWord(value: string): string {
    return /^[A-Za-z0-9_./:@#-]+$/.test(value)
        ? value
        : `'${value.replaceAll("'", `'\\''`)}'`;
}
