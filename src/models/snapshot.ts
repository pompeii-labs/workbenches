/**
 * The model catalog as data: its types, its validation, and the process-wide
 * snapshot the router reads by default. Nothing here touches a filesystem, so a
 * host on any JavaScript runtime can import it. Loading a snapshot from the
 * disk cache lives in `catalog.ts`.
 */

export interface ModelCatalogProvider {
    env: string[];
}

export interface ModelCatalogModel {
    routes: Record<string, string>;
}

export type ModelCatalogAuthenticationMethod = 'api' | 'oauth' | 'native';

export interface ModelCatalogHarnessProviderRoute {
    native_provider: string;
    auth: ModelCatalogAuthenticationMethod[];
}

export interface ModelCatalogHarnessVersion {
    providers: Record<string, ModelCatalogHarnessProviderRoute[]>;
}

export interface ModelCatalogHarness {
    versions: Record<string, ModelCatalogHarnessVersion>;
}

export interface ModelCatalogSnapshot {
    version: string;
    models: Record<string, ModelCatalogModel>;
    providers: Record<string, ModelCatalogProvider>;
    harnesses?: Record<string, ModelCatalogHarness>;
}

/**
 * The active catalog snapshot. A `ModelRouter` built without an explicit
 * snapshot reads it, so a host that uses the default activates a snapshot
 * before routing anything. It is process-global state. A host that would rather
 * not share state passes a snapshot to `new ModelRouter(snapshot)` instead.
 */
// biome-ignore lint/complexity/noStaticOnlyClass: the cache-backed catalog in catalog.ts extends it
export class ActiveModelCatalog {
    static #active: ModelCatalogSnapshot | undefined;

    /** The active snapshot, or an error when none has been activated. */
    static current(): ModelCatalogSnapshot {
        if (!ActiveModelCatalog.#active) {
            throw new Error(
                'Model metadata has not been loaded. Run the command again while connected to the internet.'
            );
        }
        return ActiveModelCatalog.#active;
    }

    static active(): ModelCatalogSnapshot | undefined {
        return ActiveModelCatalog.#active;
    }

    /** Validates `snapshot` and makes it the active one. */
    static activate(snapshot: ModelCatalogSnapshot): void {
        ActiveModelCatalog.#active = parseModelCatalogSnapshot(snapshot);
    }
}

export function parseModelCatalogSnapshot(value: unknown): ModelCatalogSnapshot {
    if (!isRecord(value) || typeof value.version !== 'string') {
        throw new Error('Invalid model catalog');
    }
    if (!isRecord(value.models) || !isRecord(value.providers)) {
        throw new Error('Invalid model catalog');
    }
    const models: Record<string, ModelCatalogModel> = {};
    for (const [id, model] of Object.entries(value.models)) {
        if (!isRecord(model) || !isRecord(model.routes)) {
            throw new Error('Invalid model catalog');
        }
        const routes: Record<string, string> = {};
        for (const [provider, nativeModel] of Object.entries(model.routes)) {
            if (typeof nativeModel !== 'string') {
                throw new Error('Invalid model catalog');
            }
            routes[provider] = nativeModel;
        }
        models[id] = { routes };
    }
    const providers: Record<string, ModelCatalogProvider> = {};
    for (const [id, provider] of Object.entries(value.providers)) {
        if (
            !isRecord(provider) ||
            !Array.isArray(provider.env) ||
            !provider.env.every((name) => typeof name === 'string')
        ) {
            throw new Error('Invalid model catalog');
        }
        providers[id] = { env: [...provider.env] };
    }
    const harnesses = parseHarnesses(value.harnesses);
    return {
        version: value.version,
        models,
        providers,
        ...(harnesses ? { harnesses } : {}),
    };
}

function parseHarnesses(
    value: unknown
): Record<string, ModelCatalogHarness> | undefined {
    if (value === undefined) return undefined;
    if (!isRecord(value)) throw new Error('Invalid model catalog');
    const harnesses: Record<string, ModelCatalogHarness> = {};
    for (const [harnessId, harness] of Object.entries(value)) {
        if (!isRecord(harness) || !isRecord(harness.versions)) {
            throw new Error('Invalid model catalog');
        }
        const versions: Record<string, ModelCatalogHarnessVersion> = {};
        for (const [versionId, version] of Object.entries(harness.versions)) {
            if (!isRecord(version) || !isRecord(version.providers)) {
                throw new Error('Invalid model catalog');
            }
            const providers: Record<string, ModelCatalogHarnessProviderRoute[]> = {};
            for (const [providerId, routes] of Object.entries(version.providers)) {
                if (!Array.isArray(routes)) throw new Error('Invalid model catalog');
                providers[providerId] = routes.map((route) => {
                    if (
                        !isRecord(route) ||
                        typeof route.native_provider !== 'string' ||
                        !route.native_provider.trim() ||
                        !Array.isArray(route.auth) ||
                        route.auth.length === 0 ||
                        !route.auth.every(isAuthenticationMethod)
                    ) {
                        throw new Error('Invalid model catalog');
                    }
                    return {
                        native_provider: route.native_provider,
                        auth: [...route.auth],
                    };
                });
            }
            versions[versionId] = { providers };
        }
        harnesses[harnessId] = { versions };
    }
    return harnesses;
}

function isAuthenticationMethod(
    value: unknown
): value is ModelCatalogAuthenticationMethod {
    return value === 'api' || value === 'oauth' || value === 'native';
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
