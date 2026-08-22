import { defineCommand } from 'citty';

import { addRemoteToCatalog, addToCatalog } from '../catalog.js';
import { fetchGitHubWorkbench } from '../github.js';
import {
    fetchRegistryWorkbench,
    parseRegistryReference,
    resolveRegistryPackage,
} from '../registry.js';
import {
    parseWorkbenchReference,
    resolveLocalSource,
    selectWorkbench,
} from '../source.js';
import { workbenchHome } from '../storage.js';
import { reportRegistryEvent, showTelemetryNotice } from '../telemetry.js';

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
        const registryReference = reference.selector
            ? undefined
            : parseRegistryReference(reference.source);
        if (registryReference) {
            const registry = await resolveRegistryPackage(registryReference);
            if (registry) {
                const workbench = registry.artifactUrl
                    ? await fetchRegistryWorkbench(registry)
                    : await fetchGitHubWorkbench(registry.source, registry.selector, {
                          revision: registry.revision,
                      });
                const catalogRegistry = {
                    url: registry.registryUrl,
                    publisher: registry.reference.publisher,
                    workbench: registry.reference.workbench,
                    version_id: registry.versionId,
                };
                const entry = await addRemoteToCatalog({
                    home: workbenchHome(),
                    alias: args.as ?? workbench.manifest.name,
                    workbench,
                    expectedDigest: registry.digest,
                    registry: catalogRegistry,
                });
                console.log(
                    `saved\t${entry.alias}\t${entry.digest}\t${entry.revision ?? ''}`
                );
                await reportRegistryEvent({
                    registry: catalogRegistry,
                    kind: 'save',
                });
                await showTelemetryNotice(workbenchHome());
                return;
            }
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
