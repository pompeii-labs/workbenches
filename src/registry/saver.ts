import type { CatalogEntry } from '../catalog/index.js';
import type { SavedWorkbenchCatalog } from '../catalog/saved.js';
import type { CatalogWriter } from '../catalog/writer.js';
import { GitHubWorkbenchSource } from '../sources/index.js';
import type { RegistryReference } from './client.js';
import { RegistryClient } from './client.js';
import { RegistryTelemetry } from './telemetry.js';

export interface RegistryWorkbenchSaverOptions {
    client?: Pick<RegistryClient, 'resolve' | 'fetchWorkbench' | 'missing'>;
    github?: Pick<GitHubWorkbenchSource, 'fetch'>;
    telemetry?: Pick<RegistryTelemetry, 'report'>;
}

export class RegistryWorkbenchSaver {
    readonly #client: Pick<RegistryClient, 'resolve' | 'fetchWorkbench' | 'missing'>;
    readonly #github: Pick<GitHubWorkbenchSource, 'fetch'>;
    readonly #telemetry: Pick<RegistryTelemetry, 'report'>;

    constructor(
        readonly home: string,
        private readonly catalog: Pick<SavedWorkbenchCatalog, 'list'>,
        private readonly writer: Pick<CatalogWriter, 'addRemote'>,
        options: RegistryWorkbenchSaverOptions = {}
    ) {
        this.#client = options.client ?? new RegistryClient({ home });
        this.#github = options.github ?? new GitHubWorkbenchSource();
        this.#telemetry = options.telemetry ?? new RegistryTelemetry({ home });
    }

    async save(reference: RegistryReference, alias?: string): Promise<CatalogEntry> {
        const registry = await this.#client.resolve(reference);
        if (!registry) throw await this.#client.missing(reference);
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
            visibility: registry.visibility,
        };
        const savedAlias = alias ?? workbench.manifest.name;
        const existing = (await this.catalog.list()).find(
            (entry) => entry.alias === savedAlias
        );
        const entry = await this.writer.addRemote({
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
