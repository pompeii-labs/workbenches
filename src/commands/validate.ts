import { defineCommand } from 'citty';

import { SavedWorkbenchCatalog } from '../catalog/index.js';
import { GitHubWorkbenchSource } from '../sources/index.js';
import { workbenchHome } from '../storage.js';
import { WorkbenchResolver, WorkbenchSource } from '../workbench/index.js';

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
            ? await new SavedWorkbenchCatalog(home).find(args.source)
            : undefined;
        if (saved) {
            const resolved = await new WorkbenchResolver().resolve(args.source, {
                home,
            });
            console.log(
                `valid\t${resolved.workbench.manifest.name}@${resolved.workbench.manifest.version}`
            );
            return;
        }
        const source = new WorkbenchSource();
        const reference = source.parse(args.source);
        const local = await source.local(reference.source);
        if (local) {
            const workbenches = await source.discover(local.directory);
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
        const workbenches = await new GitHubWorkbenchSource().fetchAll(
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
