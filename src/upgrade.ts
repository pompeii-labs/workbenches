import {
    type CatalogEntry,
    type CatalogUpgradeResult,
    readCatalog,
    upgradeCatalogEntry,
    workbenchPackageFiles,
} from './catalog.js';
import { fetchGitHubWorkbench } from './github.js';
import { fetchRegistryWorkbench, resolveRegistryPackage } from './registry.js';
import { resolveLocalSource, selectWorkbench } from './source.js';

export interface UpgradeDependencies {
    fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
}

export async function upgradeSavedWorkbench(
    home: string,
    alias: string,
    dependencies: UpgradeDependencies = {}
): Promise<CatalogUpgradeResult> {
    const entry = (await readCatalog(home)).find(
        (candidate) => candidate.alias === alias
    );
    if (!entry) throw new Error(`Saved Workbench does not exist: ${alias}`);
    return entry.registry
        ? upgradeRegistryWorkbench(home, entry, dependencies)
        : upgradeSourceWorkbench(home, entry, dependencies);
}

async function upgradeRegistryWorkbench(
    home: string,
    entry: CatalogEntry,
    dependencies: UpgradeDependencies
): Promise<CatalogUpgradeResult> {
    const savedRegistry = entry.registry;
    if (!savedRegistry) throw new Error('Saved Workbench has no registry provenance');
    const registry = await resolveRegistryPackage(
        {
            publisher: savedRegistry.publisher,
            workbench: savedRegistry.workbench,
        },
        {
            apiUrl: savedRegistry.url,
            ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
        }
    );
    if (!registry) {
        throw new Error(
            `Workbench is no longer available from ${savedRegistry.publisher}/${savedRegistry.workbench}`
        );
    }
    const workbench = registry.artifactUrl
        ? await fetchRegistryWorkbench(registry, {
              ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
          })
        : await fetchGitHubWorkbench(registry.source, registry.selector, {
              revision: registry.revision,
              ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
          });
    return upgradeCatalogEntry(home, entry.alias, {
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

async function upgradeSourceWorkbench(
    home: string,
    entry: CatalogEntry,
    dependencies: UpgradeDependencies
): Promise<CatalogUpgradeResult> {
    const local = await resolveLocalSource(entry.source);
    if (local) {
        const workbench = await selectWorkbench(local.directory, entry.selector);
        return upgradeCatalogEntry(home, entry.alias, {
            source: local.source,
            ...(local.revision ? { revision: local.revision } : {}),
            selector: entry.selector,
            manifest: workbench.manifest,
            files: await workbenchPackageFiles(workbench),
        });
    }

    const workbench = await fetchGitHubWorkbench(entry.source, entry.selector, {
        ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
    });
    return upgradeCatalogEntry(home, entry.alias, {
        source: workbench.source,
        revision: workbench.revision,
        selector: workbench.selector,
        manifest: workbench.manifest,
        files: workbench.files,
    });
}
