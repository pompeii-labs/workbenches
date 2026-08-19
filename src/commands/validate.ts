import { defineCommand } from 'citty';

import { findCatalogEntry, readCatalog } from '../catalog.js';
import { fetchGitHubWorkbenches } from '../github.js';
import { resolveReference } from '../references.js';
import {
    discoverWorkbenches,
    parseWorkbenchReference,
    resolveLocalSource,
} from '../source.js';
import { workbenchHome } from '../storage.js';

export const validateCommand = defineCommand({
    meta: {
        name: 'validate',
        description: 'Validate Workbench manifests and packages.',
    },
    args: {
        source: {
            type: 'positional',
            description: 'Workbench reference or source',
            default: '.',
        },
    },
    async run({ args }) {
        const home = workbenchHome();
        const saved = !args.source.includes('/')
            ? findCatalogEntry(await readCatalog(home), args.source)
            : undefined;
        if (saved) {
            const resolved = await resolveReference(args.source, { home });
            console.log(
                `valid\t${resolved.workbench.manifest.name}@${resolved.workbench.manifest.version}`
            );
            return;
        }
        const reference = parseWorkbenchReference(args.source);
        const local = await resolveLocalSource(reference.source);
        if (local) {
            const workbenches = await discoverWorkbenches(local.directory);
            const selected = reference.selector
                ? workbenches.filter(
                      (workbench) =>
                          workbench.packageDirectory.endsWith(
                              `/${reference.selector}`
                          ) || workbench.manifest.name === reference.selector
                  )
                : workbenches;
            if (selected.length === 0) throw new Error('No matching Workbenches found');
            for (const workbench of selected) {
                console.log(
                    `valid\t${workbench.manifest.name}@${workbench.manifest.version}`
                );
            }
            return;
        }
        const workbenches = await fetchGitHubWorkbenches(
            reference.source,
            reference.selector
        );
        if (workbenches.length === 0) throw new Error('No matching Workbenches found');
        for (const workbench of workbenches) {
            console.log(
                `valid\t${workbench.manifest.name}@${workbench.manifest.version}`
            );
        }
    },
});
