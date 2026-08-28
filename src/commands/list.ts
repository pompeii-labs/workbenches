import { basename } from 'node:path';

import { defineCommand } from 'citty';

import { SavedWorkbenchCatalog } from '../catalog/index.js';
import { GitHubWorkbenchSource } from '../sources/index.js';
import { workbenchHome } from '../storage.js';
import { WorkbenchSource } from '../workbench/index.js';

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
            for (const entry of await new SavedWorkbenchCatalog(
                workbenchHome()
            ).list()) {
                console.log(
                    `${entry.alias}\t${entry.name}@${entry.version}\t${entry.source}#${entry.selector}`
                );
            }
            return;
        }
        const source = new WorkbenchSource();
        const reference = source.parse(args.source);
        const local = await source.local(reference.source);
        if (local) {
            const workbenches = await source.discover(local.directory);
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
        const workbenches = await new GitHubWorkbenchSource().list(reference.source);
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
