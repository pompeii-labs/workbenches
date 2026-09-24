import { basename } from 'node:path';
import { isCancel, select } from '@clack/prompts';
import { defineCommand } from 'citty';
import { SavedWorkbenchCatalog } from '../catalog/index.js';
import {
    RegistryClient,
    RegistryTelemetry,
    RegistryWorkbenchSaver,
} from '../registry/index.js';
import { GitHubWorkbenchSource } from '../sources/index.js';
import { workbenchHome } from '../storage.js';
import { WorkbenchSource } from '../workbench/index.js';
import { CliPresenter } from './presenter.js';

export const addCommand = defineCommand({
    meta: {
        name: 'add',
        description: 'Save a remote package or register a live local Workbench.',
    },
    args: {
        source: {
            type: 'positional',
            description: 'Registry publisher/name, HTTPS GitHub URL, or local path',
            required: true,
        },
        name: {
            type: 'string',
            description: 'Package selector in a multi-Workbench source',
        },
        ref: { type: 'string', description: 'GitHub branch, tag, or commit' },
        as: {
            type: 'string',
            description: 'Saved alias (defaults to the manifest name)',
        },
    },
    async run({ args }) {
        const output = new CliPresenter();
        const home = workbenchHome();
        const catalog = new SavedWorkbenchCatalog(home);
        if (args.source.includes('#'))
            throw new Error('Use --name <package> instead of a #name source fragment.');
        // Bare publisher/name is exclusively a registry identity, even if a
        // similarly named relative directory happens to exist.
        const registry = RegistryClient.parseReference(args.source);
        if (registry) {
            if (args.name || args.ref)
                throw new Error(
                    '--name and --ref apply to source packages, not registry references.'
                );
            report(
                output,
                await new RegistryWorkbenchSaver(home).save(registry, args.as)
            );
            const notice = await new RegistryTelemetry({ home }).claimNotice();
            if (notice) output.message(notice, 'warning', 'stderr');
            return;
        }
        const source = new WorkbenchSource();
        if (/^https:\/\//.test(args.source)) {
            const github = new GitHubWorkbenchSource();
            github.repository(args.source);
            const options = args.ref ? { revision: args.ref } : {};
            let selector = args.name;
            if (!selector) {
                const available = await github.list(args.source, options);
                selector = await choose(
                    available.map((item) => ({
                        value: item.selector,
                        label: item.manifest.name,
                    })),
                    output.interactive
                );
            }
            const workbench = await github.fetch(args.source, selector, options);
            report(
                output,
                await catalog.addRemote({
                    alias: args.as ?? workbench.manifest.name,
                    workbench,
                    ...(args.ref ? { ref: args.ref } : {}),
                })
            );
            return;
        }
        if (args.ref) throw new Error('--ref requires an HTTPS GitHub source URL.');
        const local = await source.local(args.source);
        if (!local)
            throw new Error(
                'Use a registry publisher/name, full HTTPS GitHub URL, or an explicit local path.'
            );
        let selector = args.name;
        if (!selector) {
            const available = await source.discover(local.directory);
            selector = await choose(
                available.map((item) => ({
                    value: basename(item.packageDirectory),
                    label: item.manifest.name,
                })),
                output.interactive
            );
        }
        const workbench = await source.select(local.directory, selector);
        report(
            output,
            await catalog.addLocal({
                workbench,
                ...(args.as ? { alias: args.as } : {}),
            })
        );
    },
});

async function choose(
    options: Array<{ value: string; label: string }>,
    interactive: boolean
): Promise<string> {
    const first = options[0];
    if (!first) throw new Error('No Workbenches found in source.');
    if (options.length === 1) return first.value;
    if (!interactive)
        throw new Error(
            `Choose a package with --name. Available: ${options.map((option) => option.value).join(', ')}`
        );
    const selection = await select({
        message: 'Choose a Workbench to add',
        options: options.map((option) => ({
            ...option,
            label:
                option.label === option.value
                    ? option.label
                    : `${option.label} (${option.value})`,
        })),
    });
    if (isCancel(selection)) throw new Error('Add cancelled.');
    return selection;
}

function report(
    output: CliPresenter,
    entry: Awaited<ReturnType<SavedWorkbenchCatalog['addLocal']>>
): void {
    output.record({
        machine: [
            'saved',
            entry.alias,
            entry.localPath ?? entry.digest,
            entry.revision,
        ],
        title: `Saved ${entry.alias}`,
        details: [
            entry.localPath ? `Live local: ${entry.localPath}` : entry.digest,
            entry.revision,
        ],
    });
}
