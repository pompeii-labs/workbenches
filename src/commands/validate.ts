import { defineCommand } from 'citty';

import { SavedWorkbenchCatalog } from '../catalog/index.js';
import { GitHubWorkbenchSource } from '../sources/index.js';
import { workbenchHome } from '../storage.js';
import { WorkbenchResolver, WorkbenchSource } from '../workbench/index.js';
import { CliPresenter } from './presenter.js';

export const validateCommand = defineCommand({
    meta: {
        name: 'validate',
        alias: 'v',
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
        const output = new CliPresenter();
        const home = workbenchHome();
        const saved = !args.source.includes('/')
            ? await new SavedWorkbenchCatalog(home).find(args.source)
            : undefined;
        if (saved) {
            const resolved = await new WorkbenchResolver().resolve(args.source, {
                home,
            });
            output.record({
                machine: [
                    'valid',
                    `${resolved.workbench.manifest.name}@${resolved.workbench.manifest.version}`,
                ],
                title: `${resolved.workbench.manifest.name}@${resolved.workbench.manifest.version} is valid`,
            });
            return;
        }
        const source = new WorkbenchSource();
        const reference = source.parse(args.source);
        const local = await source.local(reference.source);
        if (local) {
            const selected = reference.selector
                ? [await source.select(local.directory, reference.selector)]
                : await source.discover(local.directory);
            if (selected.length === 0) throw new Error('No matching Workbenches found');
            for (const workbench of selected) {
                output.record({
                    machine: [
                        'valid',
                        `${workbench.manifest.name}@${workbench.manifest.version}`,
                    ],
                    title: `${workbench.manifest.name}@${workbench.manifest.version} is valid`,
                });
            }
            return;
        }
        const workbenches = await new GitHubWorkbenchSource().fetchAll(
            reference.source,
            reference.selector
        );
        if (workbenches.length === 0) throw new Error('No matching Workbenches found');
        for (const workbench of workbenches) {
            output.record({
                machine: [
                    'valid',
                    `${workbench.manifest.name}@${workbench.manifest.version}`,
                ],
                title: `${workbench.manifest.name}@${workbench.manifest.version} is valid`,
            });
        }
    },
});
