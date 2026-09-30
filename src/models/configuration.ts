import type { WorkbenchModelPolicy } from '../types.js';
import {
    ModelRouter,
    type ResolvedRunnerConfiguration,
    type RoutedWorkbench,
} from './routing.js';
import type { ModelCatalogSnapshot } from './snapshot.js';

export interface RouteConfigurationOptions {
    /** The catalog snapshot to route against. */
    catalog: ModelCatalogSnapshot;
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

/**
 * Builds the OpenCode runner configuration for a chosen provider route, the same
 * configuration `wb run --connection <provider>` resolves. It reads only its
 * arguments. It does not inspect the machine or any stored connection, so a host
 * states which credentials it holds by naming their environment variables.
 */
export function routeConfiguration(
    options: RouteConfigurationOptions
): ResolvedRunnerConfiguration {
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
    const router = new ModelRouter(options.catalog);
    const routes = router.routes(workbench);
    const available = new Set(options.environmentNames);
    const ready = (provider: string): boolean => {
        const names = options.catalog.providers[provider]?.env;
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
        const names = options.catalog.providers[route.provider]?.env ?? [];
        throw new Error(
            `The ${route.provider} route needs one of these environment variables: ${names.join(', ')}.`
        );
    }
    return router.resolve({
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
