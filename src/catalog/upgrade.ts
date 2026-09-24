import { RegistryClient } from '../registry/client.js';
import { GitHubWorkbenchSource } from '../sources/index.js';
import { SavedWorkbenchCatalog } from './saved.js';
import type { CatalogEntry, CatalogUpgradeResult } from './types.js';

export interface SavedWorkbenchUpgradeOptions {
    fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
}

export class SavedWorkbenchUpgrade {
    readonly #catalog: SavedWorkbenchCatalog;
    readonly #fetch?: SavedWorkbenchUpgradeOptions['fetch'];

    constructor(
        readonly home: string,
        options: SavedWorkbenchUpgradeOptions = {}
    ) {
        this.#catalog = new SavedWorkbenchCatalog(home);
        this.#fetch = options.fetch;
    }

    async upgrade(alias: string): Promise<CatalogUpgradeResult> {
        const entry = await this.#catalog.find(alias);
        if (!entry) throw new Error(`Saved Workbench does not exist: ${alias}`);
        return entry.registry ? this.upgradeRegistry(entry) : this.upgradeSource(entry);
    }

    private async upgradeRegistry(entry: CatalogEntry): Promise<CatalogUpgradeResult> {
        const savedRegistry = entry.registry;
        if (!savedRegistry) {
            throw new Error('Saved Workbench has no registry provenance');
        }
        const client = new RegistryClient({
            apiUrl: savedRegistry.url,
            ...(this.#fetch ? { fetch: this.#fetch } : {}),
        });
        const registry = await client.resolve({
            publisher: savedRegistry.publisher,
            workbench: savedRegistry.workbench,
        });
        if (!registry) {
            throw new Error(
                `Workbench is no longer available from ${savedRegistry.publisher}/${savedRegistry.workbench}`
            );
        }
        const workbench = registry.artifactUrl
            ? await client.fetchWorkbench(registry)
            : await this.github().fetch(registry.source, registry.selector, {
                  revision: registry.revision,
              });
        return this.#catalog.upgrade(entry.alias, {
            source: workbench.source,
            revision: workbench.revision,
            selector: workbench.selector,
            manifest: workbench.manifest,
            files: workbench.files,
            expectedDigest: registry.digest,
            registry: {
                url: registry.registryUrl,
                publisher: registry.reference.publisher,
                workbench: registry.reference.workbench,
                version_id: registry.versionId,
            },
        });
    }

    private async upgradeSource(entry: CatalogEntry): Promise<CatalogUpgradeResult> {
        if (entry.localPath || entry.source.startsWith('/')) {
            throw new Error(
                `Local Workbenches are not upgraded. Edit the source directly, or re-add a frozen local entry with wb add ${entry.source} --name ${entry.selector} --as ${entry.alias}.`
            );
        }

        const workbench = await this.github().fetch(
            entry.source,
            entry.selector,
            entry.ref ? { revision: entry.ref } : {}
        );
        return this.#catalog.upgrade(entry.alias, {
            source: workbench.source,
            revision: workbench.revision,
            selector: workbench.selector,
            manifest: workbench.manifest,
            files: workbench.files,
        });
    }

    private github(): GitHubWorkbenchSource {
        return new GitHubWorkbenchSource({
            ...(this.#fetch ? { fetch: this.#fetch } : {}),
        });
    }
}
