import { basename } from 'node:path';

import { defineCommand } from 'citty';

import { readCatalog } from '../catalog.js';
import { listGitHubWorkbenches } from '../github.js';
import {
    discoverWorkbenches,
    parseWorkbenchReference,
    resolveLocalSource,
} from '../source.js';
import { workbenchHome } from '../storage.js';

export const listCommand = defineCommand({
    meta: { name: 'list', description: 'List saved or published Workbenches.' },
    args: {
        source: {
            type: 'positional',
            description: 'Local path, GitHub URL, or GitHub owner/repo',
            required: false,
        },
        saved: {
            type: 'boolean',
            description: 'List saved Workbenches (the default without a source)',
            default: false,
        },
    },
    async run({ args }) {
        if (!args.source || args.saved) {
            for (const entry of await readCatalog(workbenchHome())) {
                console.log(
                    `${entry.alias}\t${entry.name}@${entry.version}\t${entry.source}#${entry.selector}`
                );
            }
            return;
        }
        const reference = parseWorkbenchReference(args.source);
        const local = await resolveLocalSource(reference.source);
        if (local) {
            const workbenches = await discoverWorkbenches(local.directory);
            if (workbenches.length === 0) {
                console.log('No Workbenches found.');
                return;
            }
            const selected = reference.selector
                ? workbenches.filter(
                      (workbench) =>
                          basename(workbench.packageDirectory) === reference.selector ||
                          workbench.manifest.name === reference.selector
                  )
                : workbenches;
            for (const workbench of selected) {
                console.log(
                    `${basename(workbench.packageDirectory)}\t${workbench.manifest.name}@${workbench.manifest.version}\t${workbench.manifest.description ?? ''}`
                );
            }
            return;
        }
        const workbenches = await listGitHubWorkbenches(reference.source);
        const selected = reference.selector
            ? workbenches.filter(
                  (workbench) =>
                      workbench.selector === reference.selector ||
                      workbench.manifest.name === reference.selector
              )
            : workbenches;
        if (selected.length === 0) {
            console.log('No Workbenches found.');
            return;
        }
        for (const workbench of selected) {
            console.log(
                `${workbench.selector}\t${workbench.manifest.name}@${workbench.manifest.version}\t${workbench.manifest.description ?? ''}`
            );
        }
    },
});
