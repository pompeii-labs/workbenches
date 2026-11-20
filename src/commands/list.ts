import { basename } from 'node:path';

import { defineCommand } from 'citty';

import { SavedWorkbenchCatalog } from '../catalog/index.js';
import { CloudClient } from '../cloud/client.js';
import { RunnerRegistry } from '../runners/index.js';
import { GitHubWorkbenchSource } from '../sources/index.js';
import { workbenchHome } from '../storage.js';
import { Workbench, WorkbenchSource } from '../workbench/index.js';
import { CliPresenter } from './presenter.js';

export const listCommand = defineCommand({
    meta: { name: 'list', description: 'List saved or published Workbenches.' },
    args: {
        cloud: {
            type: 'boolean',
            description:
                'List the organization library on the optional workbenches.dev hosted service',
            default: false,
        },
        json: {
            type: 'boolean',
            description: 'Print the cloud library as JSON',
            default: false,
        },
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
    async run({ args, data }) {
        const output = new CliPresenter();
        if (args.cloud) {
            if (args.source || args.saved)
                throw new Error('A source and --saved cannot be used with --cloud');
            const entries = await CloudClient.from(data).library.list();
            if (args.json) console.log(JSON.stringify(entries));
            else {
                if (!entries.length) output.message('No organization Workbenches.');
                for (const entry of entries)
                    output.record({
                        machine: [
                            entry.kind,
                            entry.reference,
                            entry.version ?? '',
                            entry.available ? 'available' : 'unavailable',
                            entry.reason ?? '',
                        ],
                        title: entry.reference,
                        details: [
                            entry.kind,
                            entry.version ?? undefined,
                            entry.available ? 'available' : 'unavailable',
                            entry.reason ?? undefined,
                        ],
                    });
            }
            return;
        }
        const runners = RunnerRegistry.standard();
        if (!args.source || args.saved) {
            const entries = await new SavedWorkbenchCatalog(workbenchHome()).list();
            if (entries.length === 0) {
                output.empty('No saved Workbenches. Save one with wb save <source>.');
                return;
            }
            for (const entry of entries) {
                const current = entry.localPath
                    ? await Workbench.load(entry.localPath, runners).catch(
                          () => undefined
                      )
                    : undefined;
                const identity = `${current?.manifest.name ?? entry.name}@${current?.manifest.version ?? entry.version}`;
                const source = entry.localPath
                    ? `${entry.localPath} (live${current ? '' : ', unavailable'})`
                    : `${entry.source} --name ${entry.selector}`;
                const internal =
                    entry.registry?.visibility === 'private' ? 'internal' : undefined;
                output.record({
                    machine: [entry.alias, identity, source, internal],
                    title: entry.alias,
                    details: [identity, source, internal],
                    tone: 'info',
                });
            }
            return;
        }
        const source = new WorkbenchSource(process.cwd(), runners);
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
