import { resolve } from 'node:path';

import { findCatalogEntry, readCatalog } from './catalog.js';
import {
    parseWorkbenchReference,
    remoteSource,
    resolveLocalSource,
    selectWorkbench,
} from './source.js';
import { workbenchHome } from './storage.js';
import type { ResolvedWorkbench } from './types.js';

export interface ResolvedReference {
    workbench: ResolvedWorkbench;
    workspaceDirectory: string;
    cleanup: () => Promise<void>;
}

export async function resolveReference(
    value: string,
    options: {
        cwd?: string;
        home?: string;
        workspaceDirectory?: string;
    } = {}
): Promise<ResolvedReference> {
    const cwd = options.cwd ?? process.cwd();
    const home = options.home ?? workbenchHome();
    if (!value.includes('/') && !value.includes('#')) {
        const saved = findCatalogEntry(await readCatalog(home), value);
        if (saved) {
            const { resolveWorkbench } = await import('./manifest.js');
            return {
                workbench: await resolveWorkbench(saved.packagePath),
                workspaceDirectory: resolve(options.workspaceDirectory ?? cwd),
                cleanup: async () => {},
            };
        }
    }

    const reference = parseWorkbenchReference(value);
    const local = await resolveLocalSource(reference.source, cwd);
    if (!local) {
        const repository = remoteSource(reference.source);
        const remoteReference = `${repository.owner}/${repository.repo}${reference.selector ? `#${reference.selector}` : ''}`;
        throw new Error(
            `Remote Workbenches must be saved before running. Run: wb add ${remoteReference}`
        );
    }
    const workbench = await selectWorkbench(local.directory, reference.selector);
    return {
        workbench,
        workspaceDirectory: resolve(
            options.workspaceDirectory ?? workbench.repositoryDirectory
        ),
        cleanup: async () => {},
    };
}
