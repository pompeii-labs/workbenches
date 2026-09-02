import { basename } from 'node:path';

import { defineCommand } from 'citty';

import { SavedWorkbenchCatalog } from '../catalog/index.js';
import { GitHubWorkbenchSource } from '../sources/index.js';
import { workbenchHome } from '../storage.js';
import { WorkbenchSource } from '../workbench/index.js';
import { CliPresenter } from './presenter.js';

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
        const output = new CliPresenter();
        if (!args.source || args.saved) {
            for (const entry of await new SavedWorkbenchCatalog(
                workbenchHome()
            ).list()) {
                output.record({
                    machine: [
                        entry.alias,
                        `${entry.name}@${entry.version}`,
                        `${entry.source}#${entry.selector}`,
                    ],
                    title: entry.alias,
                    details: [
                        `${entry.name}@${entry.version}`,
                        `${entry.source}#${entry.selector}`,
                    ],
                    tone: 'info',
                });
            }
            return;
        }
        const source = new WorkbenchSource();
        const reference = source.parse(args.source);
        const local = await source.local(reference.source);
        if (local) {
            const workbenches = await source.discover(local.directory);
            if (workbenches.length === 0) {
                output.message('No Workbenches found.');
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
                output.record({
                    machine: [
                        basename(workbench.packageDirectory),
                        `${workbench.manifest.name}@${workbench.manifest.version}`,
                        workbench.manifest.description ?? '',
                    ],
                    title: basename(workbench.packageDirectory),
                    details: [
                        `${workbench.manifest.name}@${workbench.manifest.version}`,
                        workbench.manifest.description,
                    ],
                    tone: 'info',
                });
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
            output.message('No Workbenches found.');
            return;
        }
        for (const workbench of selected) {
            output.record({
                machine: [
                    workbench.selector,
                    `${workbench.manifest.name}@${workbench.manifest.version}`,
                    workbench.manifest.description ?? '',
                ],
                title: workbench.selector,
                details: [
                    `${workbench.manifest.name}@${workbench.manifest.version}`,
                    workbench.manifest.description,
                ],
                tone: 'info',
            });
        }
    },
});
