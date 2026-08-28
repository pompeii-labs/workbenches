import { defineCommand } from 'citty';

import { SavedWorkbenchCatalog } from '../catalog/index.js';
import { RegistryClient, RegistryTelemetry } from '../registry/index.js';
import { GitHubWorkbenchSource } from '../sources/index.js';
import { workbenchHome } from '../storage.js';
import { WorkbenchSource } from '../workbench/index.js';

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
        const catalog = new SavedWorkbenchCatalog(workbenchHome());
        const github = new GitHubWorkbenchSource();
        const workbenchSource = new WorkbenchSource();
        const reference = workbenchSource.parse(args.source);
        const source = await workbenchSource.local(reference.source);
        if (source) {
            const workbench = await workbenchSource.select(
                source.directory,
                reference.selector
            );
            const entry = await catalog.add({
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
        const registryClient = new RegistryClient();
        const registryReference = reference.selector
            ? undefined
            : RegistryClient.parseReference(reference.source);
        if (registryReference) {
            const registry = await registryClient.resolve(registryReference);
            if (registry) {
                const telemetry = new RegistryTelemetry();
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
                const entry = await catalog.addRemote({
                    alias: args.as ?? workbench.manifest.name,
                    workbench,
                    expectedDigest: registry.digest,
                    registry: catalogRegistry,
                });
                console.log(
                    `saved\t${entry.alias}\t${entry.digest}\t${entry.revision ?? ''}`
                );
                await telemetry.report({
                    registry: catalogRegistry,
                    kind: 'save',
                });
                await telemetry.showNotice();
                return;
            }
        }
        const workbench = await github.fetch(reference.source, reference.selector);
        const entry = await catalog.addRemote({
            alias: args.as ?? workbench.manifest.name,
            workbench,
        });
        console.log(`saved\t${entry.alias}\t${entry.digest}\t${entry.revision ?? ''}`);
    },
});
