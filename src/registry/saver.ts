import type { CatalogEntry } from '../catalog/index.js';
import { SavedWorkbenchCatalog } from '../catalog/index.js';
import { GitHubWorkbenchSource } from '../sources/index.js';
import type { RegistryReference } from './client.js';
import { RegistryClient } from './client.js';
import { RegistryTelemetry } from './telemetry.js';

export interface RegistryWorkbenchSaverOptions {
    client?: Pick<RegistryClient, 'resolve' | 'fetchWorkbench'>;
    catalog?: Pick<SavedWorkbenchCatalog, 'list' | 'addRemote'>;
    github?: Pick<GitHubWorkbenchSource, 'fetch'>;
    telemetry?: Pick<RegistryTelemetry, 'report'>;
}

export class RegistryWorkbenchSaver {
    readonly #client: Pick<RegistryClient, 'resolve' | 'fetchWorkbench'>;
    readonly #catalog: Pick<SavedWorkbenchCatalog, 'list' | 'addRemote'>;
    readonly #github: Pick<GitHubWorkbenchSource, 'fetch'>;
    readonly #telemetry: Pick<RegistryTelemetry, 'report'>;

    constructor(
        readonly home: string,
        options: RegistryWorkbenchSaverOptions = {}
    ) {
        this.#client = options.client ?? new RegistryClient();
        this.#catalog = options.catalog ?? new SavedWorkbenchCatalog(home);
        this.#github = options.github ?? new GitHubWorkbenchSource();
        this.#telemetry = options.telemetry ?? new RegistryTelemetry({ home });
    }

    async save(reference: RegistryReference): Promise<CatalogEntry> {
        const entries = await this.#catalog.list();
        const existing = entries.find(
            (entry) =>
                entry.registry?.publisher === reference.publisher &&
                entry.registry.workbench === reference.workbench
        );
        if (existing) return existing;

        const registry = await this.#client.resolve(reference);
        if (!registry) {
            throw new Error(
                `Registry Workbench does not exist: ${reference.publisher}/${reference.workbench}`
            );
        }
        const workbench = registry.artifactUrl
            ? await this.#client.fetchWorkbench(registry)
            : await this.#github.fetch(registry.source, registry.selector, {
                  revision: registry.revision,
              });
        const catalogRegistry = {
            url: registry.registryUrl,
            publisher: registry.reference.publisher,
            workbench: registry.reference.workbench,
            version_id: registry.versionId,
        };
        const entry = await this.#catalog.addRemote({
            alias: this.alias(entries, reference),
            workbench,
            expectedDigest: registry.digest,
            registry: catalogRegistry,
        });
        await this.#telemetry.report({ registry: catalogRegistry, kind: 'save' });
        return entry;
    }

    private alias(entries: CatalogEntry[], reference: RegistryReference): string {
        const occupied = new Set(entries.map((entry) => entry.alias));
        if (!occupied.has(reference.workbench)) return reference.workbench;
        const qualified = `${reference.publisher}-${reference.workbench}`;
        if (!occupied.has(qualified)) return qualified;
        let suffix = 2;
        while (occupied.has(`${qualified}-${suffix}`)) suffix += 1;
        return `${qualified}-${suffix}`;
    }
}
