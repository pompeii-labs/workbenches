import { resolve } from 'node:path';

import {
    type CatalogRegistryReference,
    SavedWorkbenchCatalog,
} from '../catalog/index.js';
import { workbenchHome } from '../storage.js';
import type { ResolvedWorkbench } from '../types.js';
import { WorkbenchSource } from './source.js';
import { Workbench } from './workbench.js';

export interface ResolvedWorkbenchReference {
    workbench: ResolvedWorkbench;
    workspaceDirectory: string;
    cleanup: () => Promise<void>;
    registry?: CatalogRegistryReference;
}

export interface WorkbenchResolverOptions {
    cwd?: string;
    home?: string;
    workspaceDirectory?: string;
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
                    workbench: await Workbench.load(saved.packagePath),
                    workspaceDirectory: resolve(options.workspaceDirectory ?? cwd),
                    cleanup: async () => {},
                    ...(saved.registry ? { registry: saved.registry } : {}),
                };
            }
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
            workspaceDirectory: resolve(
                options.workspaceDirectory ?? workbench.repositoryDirectory
            ),
            cleanup: async () => {},
        };
    }
}
