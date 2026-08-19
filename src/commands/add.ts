import { defineCommand } from 'citty';

import { addRemoteToCatalog, addToCatalog } from '../catalog.js';
import { fetchGitHubWorkbench } from '../github.js';
import {
    parseWorkbenchReference,
    resolveLocalSource,
    selectWorkbench,
} from '../source.js';
import { workbenchHome } from '../storage.js';

export const addCommand = defineCommand({
    meta: { name: 'add', description: 'Save an immutable Workbench package snapshot.' },
    args: {
        source: {
            type: 'positional',
            description: 'Workbench reference (use #name for multi-Workbench repos)',
            required: true,
        },
        as: {
            type: 'string',
            description: 'Saved alias (defaults to the manifest name)',
        },
    },
    async run({ args }) {
        const reference = parseWorkbenchReference(args.source);
        const source = await resolveLocalSource(reference.source);
        if (source) {
            const workbench = await selectWorkbench(
                source.directory,
                reference.selector
            );
            const entry = await addToCatalog({
                home: workbenchHome(),
                alias: args.as ?? workbench.manifest.name,
                source: source.source,
                ...(source.revision ? { revision: source.revision } : {}),
                workbench,
            });
            console.log(
                `saved\t${entry.alias}\t${entry.digest}${entry.revision ? `\t${entry.revision}` : ''}`
            );
            return;
        }
        const workbench = await fetchGitHubWorkbench(
            reference.source,
            reference.selector
        );
        const entry = await addRemoteToCatalog({
            home: workbenchHome(),
            alias: args.as ?? workbench.manifest.name,
            workbench,
        });
        console.log(`saved\t${entry.alias}\t${entry.digest}\t${entry.revision ?? ''}`);
    },
});
