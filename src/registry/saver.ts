import type { CatalogEntry } from '../catalog/index.js';
import { SavedWorkbenchCatalog } from '../catalog/saved.js';
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

    async save(reference: RegistryReference, alias?: string): Promise<CatalogEntry> {
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
        const savedAlias = alias ?? workbench.manifest.name;
        const existing = (await this.#catalog.list()).find(
            (entry) => entry.alias === savedAlias
        );
        const entry = await this.#catalog.addRemote({
            alias: savedAlias,
            workbench,
            expectedDigest: registry.digest,
            registry: catalogRegistry,
        });
        if (!existing)
            await this.#telemetry.report({ registry: catalogRegistry, kind: 'save' });
        return entry;
    }
}
