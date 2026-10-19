import type { SavedWorkbenchCatalog } from '../catalog/saved.js';
import {
    type RegistryAccountStore,
    type RegistryPublisher,
    registryVisibilityLabel,
} from '../registry/index.js';
import { RunnerRegistry } from '../runners/index.js';
import {
    Workbench,
    type WorkbenchInspector,
    WorkbenchResolver,
} from '../workbench/index.js';

/** Catalog search, inspection, and push for MCP clients. */
export class McpWorkbenchOperations {
    constructor(
        private readonly home: string,
        private readonly cwd: string,
        private readonly catalog: Pick<SavedWorkbenchCatalog, 'list'>,
        private readonly accounts: Pick<RegistryAccountStore, 'list' | 'client'>,
        private readonly inspector: Pick<WorkbenchInspector, 'inspect'>,
        private readonly publisher: Pick<RegistryPublisher, 'account' | 'push'>
    ) {}

    async search(query = '', limit = 20): Promise<Record<string, unknown>[]> {
        const normalized = query.trim().toLowerCase();
        const local = await Promise.all(
            (await this.catalog.list()).map(async (entry) => {
                const workbench = await Workbench.load(
                    entry.localPath ?? entry.packagePath,
                    RunnerRegistry.standard()
                ).catch(() => undefined);
                return {
                    source: 'local',
                    workbench: entry.alias,
                    alias: entry.alias,
                    name: workbench?.manifest.name ?? entry.name,
                    version: workbench?.manifest.version ?? entry.version,
                    ...(workbench?.manifest.description
                        ? { description: workbench.manifest.description }
                        : {}),
                };
            })
        );
        const matchingLocal = local.filter((entry) =>
            [entry.alias, entry.name, entry.description]
                .filter((value): value is string => typeof value === 'string')
                .some((value) => value.toLowerCase().includes(normalized))
        );
        const accounts = this.accounts;
        const registry =
            (await accounts.list()).organizations.length === 0
                ? []
                : (await accounts.client.search(query)).map((entry) => ({
                      source: 'registry',
                      workbench: `${entry.reference.publisher}/${entry.reference.workbench}`,
                      name: entry.name,
                      version: entry.version,
                      ...(entry.summary ? { description: entry.summary } : {}),
                      publisher: entry.publisherName,
                      visibility: registryVisibilityLabel(entry.visibility),
                  }));
        return [...matchingLocal, ...registry].slice(0, limit);
    }

    async view(workbench: string): Promise<Record<string, unknown>> {
        return { ...(await this.inspector.inspect(workbench)).data };
    }

    async push(path: string, org?: string): Promise<Record<string, unknown>> {
        const publisher = this.publisher;
        const account = await publisher.account(org);
        const resolved = await new WorkbenchResolver().resolve(path, {
            home: this.home,
            cwd: this.cwd,
        });
        try {
            if (resolved.source !== 'local') {
                throw new Error('push requires a local Workbench package path');
            }
            const pushed = await publisher.push(account, resolved.workbench);
            return {
                reference: `${pushed.reference.publisher}/${pushed.reference.workbench}`,
                version: pushed.version,
                digest: pushed.digest,
                visibility: registryVisibilityLabel(pushed.visibility),
            };
        } finally {
            await resolved.cleanup();
        }
    }
}
