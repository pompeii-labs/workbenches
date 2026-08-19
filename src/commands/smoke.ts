import { basename } from 'node:path';

import { defineCommand } from 'citty';

import { findCatalogEntry, readCatalog } from '../catalog.js';
import { fetchGitHubWorkbenches, resolvedRemoteWorkbench } from '../github.js';
import type { PreflightResult } from '../preflight.js';
import { resolveReference } from '../references.js';
import { smokeWorkbenchRuntime } from '../runtime.js';
import {
    discoverWorkbenches,
    parseWorkbenchReference,
    resolveLocalSource,
} from '../source.js';
import { workbenchHome } from '../storage.js';

export const smokeCommand = defineCommand({
    meta: {
        name: 'smoke',
        description: 'Verify a Workbench can start without spending model tokens.',
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
            ? findCatalogEntry(await readCatalog(home), args.source)
            : undefined;
        if (saved) {
            const resolved = await resolveReference(args.source, { home });
            printResult(
                resolved.workbench.manifest.name,
                await smokeWorkbenchRuntime({
                    workbench: resolved.workbench,
                    workspaceDirectory: resolved.workspaceDirectory,
                })
            );
            return;
        }
        const reference = parseWorkbenchReference(args.source);
        const local = await resolveLocalSource(reference.source);
        if (local) {
            const workbenches = await discoverWorkbenches(local.directory);
            const selected = reference.selector
                ? workbenches.filter(
                      (workbench) =>
                          basename(workbench.packageDirectory) === reference.selector ||
                          workbench.manifest.name === reference.selector
                  )
                : workbenches;
            if (selected.length === 0) throw new Error('No matching Workbenches found');
            for (const workbench of selected) {
                printResult(
                    workbench.manifest.name,
                    await smokeWorkbenchRuntime({ workbench })
                );
            }
            return;
        }
        const workbenches = await fetchGitHubWorkbenches(
            reference.source,
            reference.selector
        );
        if (workbenches.length === 0) throw new Error('No matching Workbenches found');
        for (const workbench of workbenches) {
            printResult(
                workbench.manifest.name,
                await smokeWorkbenchRuntime({
                    workbench: resolvedRemoteWorkbench(workbench),
                })
            );
        }
    },
});

function printResult(name: string, result: PreflightResult) {
    const disabled = result.disabledMcps.length
        ? `; optional MCPs disabled: ${result.disabledMcps.join(', ')}`
        : '';
    console.log(
        `ready\t${name}\trunner=${result.runner.path}\ttools=${result.tools.map((tool) => tool.path).join(',') || '-'}${disabled}`
    );
}
