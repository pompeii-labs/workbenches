import { basename } from 'node:path';
import { isCancel, select } from '@clack/prompts';
import { defineCommand } from 'citty';
import {
    type CatalogEntry,
    SavedWorkbenchCatalog,
    WorkbenchPackage,
} from '../catalog/index.js';
import { RegistryClient, RegistryTelemetry } from '../registry/index.js';
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
            description: 'Workbench name in a multi-Workbench source',
        },
        ref: { type: 'string', description: 'GitHub branch, tag, or commit' },
        force: {
            type: 'boolean',
            alias: 'f',
            description:
                'Replace an already saved Workbench when its package has changed',
        },
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
        const registryReference = RegistryClient.parseReference(args.source);
        if (registryReference) {
            if (args.name || args.ref)
                throw new Error(
                    '--name and --ref apply to source packages, not registry references.'
                );
            const registryClient = new RegistryClient();
            const registry = await registryClient.resolve(registryReference);
            if (!registry)
                throw new Error(
                    `Registry Workbench does not exist: ${registryReference.publisher}/${registryReference.workbench}`
                );
            const github = new GitHubWorkbenchSource();
            const workbench = registry.artifactUrl
                ? await registryClient.fetchWorkbench(registry)
                : await github.fetch(registry.source, registry.selector, {
                      revision: registry.revision,
                  });
            const catalogRegistry = {
                url: registry.registryUrl,
                publisher: registry.reference.publisher,
                workbench: registry.reference.workbench,
                version_id: registry.versionId,
            };
            const alias = args.as ?? workbench.manifest.name;
            const saved = await saveCandidate({
                catalog,
                alias,
                digest: WorkbenchPackage.digest(workbench.files),
                force: args.force,
                save: () =>
                    catalog.addRemote({
                        alias,
                        workbench,
                        expectedDigest: registry.digest,
                        registry: catalogRegistry,
                    }),
                upgrade: () =>
                    catalog.upgrade(alias, {
                        source: workbench.source,
                        selector: workbench.selector,
                        manifest: workbench.manifest,
                        files: workbench.files,
                        revision: workbench.revision,
                        expectedDigest: registry.digest,
                        registry: catalogRegistry,
                    }),
            });
            presentSaved(output, saved);
            if (saved.status !== 'current')
                await new RegistryTelemetry({ home }).report({
                    registry: catalogRegistry,
                    kind: 'save',
                });
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
            const alias = args.as ?? workbench.manifest.name;
            presentSaved(
                output,
                await saveCandidate({
                    catalog,
                    alias,
                    digest: WorkbenchPackage.digest(workbench.files),
                    force: args.force,
                    save: () =>
                        catalog.addRemote({
                            alias,
                            workbench,
                            ...(args.ref ? { ref: args.ref } : {}),
                        }),
                    upgrade: () =>
                        catalog.upgrade(alias, {
                            source: workbench.source,
                            selector: workbench.selector,
                            manifest: workbench.manifest,
                            files: workbench.files,
                            revision: workbench.revision,
                            ...(args.ref ? { ref: args.ref } : {}),
                        }),
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
        const alias = args.as ?? workbench.manifest.name;
        const files = await new WorkbenchPackage(workbench).files();
        presentSaved(
            output,
            await saveCandidate({
                catalog,
                alias,
                digest: WorkbenchPackage.digest(files),
                force: args.force,
                save: () =>
                    catalog.addLocal({
                        workbench,
                        ...(args.as ? { alias: args.as } : {}),
                    }),
                upgrade: async () => ({
                    entry: await catalog.addLocal({
                        workbench,
                        ...(args.as ? { alias: args.as } : {}),
                    }),
                }),
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

async function saveCandidate(options: {
    catalog: SavedWorkbenchCatalog;
    alias: string;
    digest: string;
    force: boolean | undefined;
    save: () => Promise<CatalogEntry>;
    upgrade: () => Promise<{ entry: CatalogEntry }>;
}): Promise<{ entry: CatalogEntry; status: 'saved' | 'current' | 'updated' }> {
    const existing = await options.catalog.find(options.alias);
    if (!existing) return { entry: await options.save(), status: 'saved' };
    if (existing.digest === options.digest)
        return { entry: existing, status: 'current' };
    if (!options.force)
        throw new Error(
            `Saved Workbench ${options.alias} has changed. Rerun with --force to replace it.`
        );
    return { entry: (await options.upgrade()).entry, status: 'updated' };
}

function presentSaved(
    output: CliPresenter,
    saved: { entry: CatalogEntry; status: 'saved' | 'current' | 'updated' }
): void {
    const { entry } = saved;
    if (saved.status === 'current') {
        output.record({
            machine: [
                'current',
                entry.alias,
                entry.localPath ?? entry.digest,
                entry.revision ?? '',
            ],
            title: `Already saved: ${entry.alias}`,
            details: ['Up to date'],
        });
        return;
    }
    output.record({
        machine: [
            saved.status,
            entry.alias,
            entry.localPath ?? entry.digest,
            entry.revision ?? '',
        ],
        title:
            saved.status === 'updated'
                ? `Updated ${entry.alias}`
                : `Saved ${entry.alias}`,
        details: [
            entry.localPath ? `Live local: ${entry.localPath}` : entry.digest,
            entry.revision,
        ],
    });
}
