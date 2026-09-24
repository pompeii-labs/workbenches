import { resolve } from 'node:path';

import { SavedWorkbenchCatalog } from '../catalog/saved.js';
import type { CatalogRegistryReference } from '../catalog/types.js';
import type { RepositoryRequest } from '../repositories/contracts.js';
import { workbenchHome } from '../storage.js';
import type { ResolvedWorkbench } from '../types.js';
import { WorkbenchSource } from './source.js';
import { Workbench } from './workbench.js';

export interface ResolvedWorkbenchReference {
    workbench: ResolvedWorkbench;
    workspaceDirectory: string;
    cleanup: () => Promise<void>;
    source?: 'local' | 'saved' | 'system';
    registry?: CatalogRegistryReference;
    repository?: RepositoryRequest;
}

export interface WorkbenchResolverOptions {
    cwd?: string;
    home?: string;
    workspaceDirectory?: string;
    savedOnly?: boolean;
}

export class WorkbenchResolver {
    async resolve(
        value: string,
        options: WorkbenchResolverOptions = {}
    ): Promise<ResolvedWorkbenchReference> {
        const cwd = options.cwd ?? process.cwd();
        const home = options.home ?? workbenchHome();
        if (!value.includes('/') && !value.includes('#')) {
            const saved = await new SavedWorkbenchCatalog(home).find(value);
            if (saved) {
                return {
                    workbench: await Workbench.load(
                        saved.localPath ?? saved.packagePath
                    ),
                    workspaceDirectory: resolve(options.workspaceDirectory ?? cwd),
                    cleanup: async () => {},
                    source: saved.localPath ? 'local' : 'saved',
                    ...(saved.registry ? { registry: saved.registry } : {}),
                };
            }
        }

        if (options.savedOnly) {
            throw new Error(
                `Workbench is not saved: ${value}. Add it first with wb add <source>, then run its saved alias.`
            );
        }

        const source = new WorkbenchSource(cwd);
        const reference = source.parse(value);
        const local = await source.local(reference.source);
        if (!local) {
            const repository = source.remote(reference.source);
            const remoteReference = `${repository.owner}/${repository.repo}${
                reference.selector ? `#${reference.selector}` : ''
            }`;
            throw new Error(
                `Remote Workbenches must be saved before running. Run: wb add ${remoteReference}`
            );
        }

        const workbench = await source.select(local.directory, reference.selector);
        return {
            workbench,
            workspaceDirectory: resolve(options.workspaceDirectory ?? cwd),
            cleanup: async () => {},
            source: 'local',
        };
    }
}
