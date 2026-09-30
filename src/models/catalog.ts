import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { WORKBENCH_USER_AGENT } from '../user-agent.js';
import {
    ModelCatalog as ActiveModelCatalog,
    type ModelCatalogSnapshot,
    parseModelCatalogSnapshot,
} from './snapshot.js';

export type {
    ModelCatalogAuthenticationMethod,
    ModelCatalogHarness,
    ModelCatalogHarnessProviderRoute,
    ModelCatalogHarnessVersion,
    ModelCatalogModel,
    ModelCatalogProvider,
    ModelCatalogSnapshot,
} from './snapshot.js';

const metadataOrigin = 'https://metadata.workbenches.dev';
const latestCatalogUrl = `${metadataOrigin}/models/v1/latest.json`;
const defaultMaximumAge = 6 * 60 * 60 * 1_000;
const maximumCatalogSize = 2 * 1024 * 1024;

export interface ModelCatalogResult {
    catalog: ModelCatalogSnapshot;
    source: 'cache' | 'remote';
    refreshed: boolean;
}

export type ModelCatalogFetch = (
    input: string | URL | Request,
    init?: RequestInit
) => Promise<Response>;

/**
 * The catalog cached under the Workbench home directory and refreshed from the
 * published metadata. It extends the snapshot state in `snapshot.ts`, so
 * `current`, `active`, and `activate` are the same process-wide snapshot. Only
 * the CLI reads the cache. A host that embeds the engine supplies a snapshot
 * itself and never imports this module.
 */
export class ModelCatalog extends ActiveModelCatalog {
    readonly #fetch: ModelCatalogFetch;
    readonly #home: string;
    readonly #maximumAge: number;

    constructor(options: {
        home: string;
        fetch?: ModelCatalogFetch;
        maximumAge?: number;
    }) {
        super();
        this.#home = options.home;
        // Keep `this` undefined when calling, as some runtimes require.
        const fetcher = options.fetch ?? fetch;
        this.#fetch = (input, init) => fetcher(input, init);
        this.#maximumAge = options.maximumAge ?? defaultMaximumAge;
    }

    async loadCached(): Promise<ModelCatalogResult> {
        const cached = await this.#readCache();
        if (!cached) {
            throw new Error(
                'Model metadata is not cached. Run the command again while connected to the internet.'
            );
        }
        ActiveModelCatalog.activate(cached.catalog);
        return {
            catalog: cached.catalog,
            source: 'cache',
            refreshed: false,
        };
    }

    async refresh(now = Date.now()): Promise<ModelCatalogResult> {
        const cached = await this.#readCache();
        if (cached) ActiveModelCatalog.activate(cached.catalog);
        if (cached && now - cached.state.checkedAt < this.#maximumAge) {
            return {
                catalog: cached.catalog,
                source: 'cache',
                refreshed: false,
            };
        }

        try {
            const manifest = await this.#fetchManifest();
            if (cached?.manifest.sha256 === manifest.sha256) {
                if (cached.catalog.version !== manifest.version) {
                    throw new Error(
                        'Model metadata version does not match its manifest'
                    );
                }
                await this.#writeState({
                    checkedAt: now,
                    sha256: manifest.sha256,
                });
                return {
                    catalog: cached.catalog,
                    source: 'cache',
                    refreshed: true,
                };
            }

            const source = await this.#fetchArtifact(manifest);
            const catalog = parseModelCatalogSnapshot(
                JSON.parse(new TextDecoder().decode(source))
            );
            if (catalog.version !== manifest.version) {
                throw new Error('Model metadata version does not match its manifest');
            }
            await this.#writeCache(manifest, source, {
                checkedAt: now,
                sha256: manifest.sha256,
            });
            ActiveModelCatalog.activate(catalog);
            return { catalog, source: 'remote', refreshed: true };
        } catch (error) {
            if (cached) {
                return {
                    catalog: cached.catalog,
                    source: 'cache',
                    refreshed: false,
                };
            }
            const detail = error instanceof Error ? `: ${error.message}` : '';
            throw new Error(`Model metadata could not be loaded${detail}`, {
                cause: error,
            });
        }
    }

    async #fetchManifest(): Promise<ModelCatalogManifest> {
        const response = await this.#fetch(latestCatalogUrl, {
            headers: {
                accept: 'application/json',
                'user-agent': WORKBENCH_USER_AGENT,
            },
            signal: AbortSignal.timeout(3_000),
        });
        if (!response.ok) {
            throw new Error(`Model metadata returned HTTP ${response.status}`);
        }
        return parseManifest(await response.json());
    }

    async #fetchArtifact(manifest: ModelCatalogManifest): Promise<Uint8Array> {
        const response = await this.#fetch(
            new URL(`/${manifest.artifact}`, metadataOrigin),
            {
                headers: {
                    accept: 'application/json',
                    'user-agent': WORKBENCH_USER_AGENT,
                },
                signal: AbortSignal.timeout(5_000),
            }
        );
        if (!response.ok) {
            throw new Error(`Model metadata returned HTTP ${response.status}`);
        }
        const source = new Uint8Array(await response.arrayBuffer());
        verifyArtifact(source, manifest);
        return source;
    }

    async #readCache(): Promise<CachedModelCatalog | undefined> {
        try {
            const [manifestSource, stateSource] = await Promise.all([
                readFile(manifestPath(this.#home), 'utf8'),
                readFile(statePath(this.#home), 'utf8'),
            ]);
            const manifest = parseManifest(JSON.parse(manifestSource));
            const state = parseState(JSON.parse(stateSource));
            if (state.sha256 !== manifest.sha256) return undefined;
            const source = new Uint8Array(
                await readFile(artifactPath(this.#home, manifest))
            );
            verifyArtifact(source, manifest);
            const catalog = parseModelCatalogSnapshot(
                JSON.parse(new TextDecoder().decode(source))
            );
            if (catalog.version !== manifest.version) return undefined;
            return { catalog, manifest, state };
        } catch {
            return undefined;
        }
    }

    async #writeCache(
        manifest: ModelCatalogManifest,
        source: Uint8Array,
        state: ModelCatalogState
    ): Promise<void> {
        await atomicWrite(artifactPath(this.#home, manifest), source);
        await atomicWrite(manifestPath(this.#home), `${JSON.stringify(manifest)}\n`);
        await this.#writeState(state);
    }

    async #writeState(state: ModelCatalogState): Promise<void> {
        await atomicWrite(statePath(this.#home), `${JSON.stringify(state)}\n`);
    }
}

function parseManifest(value: unknown): ModelCatalogManifest {
    if (!isRecord(value)) throw new Error('Invalid model metadata manifest');
    if (value.schema !== 1 || value.catalog !== 'models') {
        throw new Error('Unsupported model metadata manifest');
    }
    if (
        typeof value.version !== 'string' ||
        typeof value.artifact !== 'string' ||
        !/^models\/v1\/[a-f0-9]{64}\.json$/.test(value.artifact) ||
        typeof value.sha256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(value.sha256) ||
        typeof value.size !== 'number' ||
        !Number.isSafeInteger(value.size) ||
        value.size <= 0 ||
        value.size > maximumCatalogSize
    ) {
        throw new Error('Invalid model metadata manifest');
    }
    if (value.artifact !== `models/v1/${value.sha256}.json`) {
        throw new Error('Invalid model metadata manifest');
    }
    return {
        schema: 1,
        catalog: 'models',
        version: value.version,
        artifact: value.artifact,
        sha256: value.sha256,
        size: value.size,
    };
}

function parseState(value: unknown): ModelCatalogState {
    if (
        !isRecord(value) ||
        typeof value.checkedAt !== 'number' ||
        !Number.isSafeInteger(value.checkedAt) ||
        typeof value.sha256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(value.sha256)
    ) {
        throw new Error('Invalid model metadata state');
    }
    return { checkedAt: value.checkedAt, sha256: value.sha256 };
}

function verifyArtifact(source: Uint8Array, manifest: ModelCatalogManifest): void {
    if (source.byteLength !== manifest.size) {
        throw new Error('Model metadata size does not match its manifest');
    }
    const digest = createHash('sha256').update(source).digest('hex');
    if (digest !== manifest.sha256) {
        throw new Error('Model metadata digest does not match its manifest');
    }
}

async function atomicWrite(path: string, source: Uint8Array | string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
        await writeFile(temporary, source);
        await rename(temporary, path);
    } finally {
        await rm(temporary, { force: true });
    }
}

function manifestPath(home: string): string {
    return join(home, 'metadata', 'models', 'v1', 'latest.json');
}

function artifactPath(home: string, manifest: ModelCatalogManifest): string {
    return join(home, 'metadata', ...manifest.artifact.split('/'));
}

function statePath(home: string): string {
    return join(home, 'metadata', 'models', 'state.json');
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface ModelCatalogManifest {
    schema: 1;
    catalog: 'models';
    version: string;
    artifact: string;
    sha256: string;
    size: number;
}

interface ModelCatalogState {
    checkedAt: number;
    sha256: string;
}

interface CachedModelCatalog {
    catalog: ModelCatalogSnapshot;
    manifest: ModelCatalogManifest;
    state: ModelCatalogState;
}
