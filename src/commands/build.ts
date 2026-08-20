import { defineCommand } from 'citty';

import { resolveReference } from '../references.js';
import { createRuntimeProviderRegistry } from '../runtime.js';

export const buildCommand = defineCommand({
    meta: {
        name: 'build',
        description: 'Prepare and cache a Workbench runtime image.',
    },
    args: {
        workbench: {
            type: 'positional',
            description: 'Saved alias or local Workbench reference',
            required: true,
        },
        dir: {
            type: 'string',
            description:
                'Workspace directory (saved aliases default to the current directory)',
        },
        json: {
            type: 'boolean',
            description: 'Emit preparation metadata as JSON',
            default: false,
        },
    },
    async run({ args }) {
        const resolved = await resolveReference(args.workbench, {
            ...(args.dir ? { workspaceDirectory: args.dir } : {}),
        });
        const workbench = resolved.workbench;
        if (workbench.manifest.runtime !== 'docker') {
            throw new Error(
                `Workbench runtime does not prepare an image: ${workbench.manifest.runtime}`
            );
        }
        const runtime = await createRuntimeProviderRegistry()
            .resolve(workbench.manifest.runtime)
            .prepare({
                workbench,
                workspaceDirectory: resolved.workspaceDirectory,
                environment: process.env,
                assets: [
                    {
                        path: resolved.workspaceDirectory,
                        access: 'read-write',
                    },
                    {
                        path: workbench.packageDirectory,
                        access: 'read-only',
                    },
                ],
            });
        try {
            const preparation = runtime.preparation;
            if (preparation?.kind !== 'image') {
                throw new Error('Docker provider did not report image preparation');
            }
            if (args.json) {
                process.stdout.write(`${JSON.stringify(preparation)}\n`);
                return;
            }
            const excluded = preparation.excludedPaths?.length
                ? `\texcluded=${preparation.excludedPaths.length}`
                : '';
            console.log(
                `prepared\t${workbench.manifest.name}\taction=${preparation.action}\timage=${preparation.immutableReference}${excluded}`
            );
        } finally {
            await runtime.cleanup();
            await resolved.cleanup();
        }
    },
});
