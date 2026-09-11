import { defineCommand } from 'citty';

import { type PreparedRuntime, RuntimeRegistry } from '../runtimes/index.js';
import { WorkbenchResolver } from '../workbench/index.js';
import { CliPresenter } from './presenter.js';

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
        const output = new CliPresenter();
        const resolved = await new WorkbenchResolver().resolve(args.workbench, {
            ...(args.dir ? { workspaceDirectory: args.dir } : {}),
        });
        const workbench = resolved.workbench;
        let runtime: PreparedRuntime | undefined;
        try {
            if (!['docker', 'e2b'].includes(workbench.manifest.runtime)) {
                throw new Error(
                    `wb build only applies to image-backed Workbenches. ${workbench.manifest.name} uses the ${workbench.manifest.runtime} runtime.`
                );
            }
            if (!args.json) {
                output.message(
                    `Preparing runtime image for ${workbench.manifest.name}...`,
                    'info',
                    'stderr'
                );
            }
            runtime = await RuntimeRegistry.standard()
                .resolve(workbench.manifest.runtime)
                .prepare({
                    workbench,
                    workspaceDirectory: resolved.workspaceDirectory,
                    environment: process.env,
                    purpose: 'build',
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
            const preparation = runtime.preparation;
            if (preparation?.kind !== 'image') {
                throw new Error('Runtime provider did not report image preparation');
            }
            if (args.json) {
                process.stdout.write(`${JSON.stringify(preparation)}\n`);
                return;
            }
            const excluded = preparation.excludedPaths?.length;
            output.record({
                machine: [
                    'prepared',
                    workbench.manifest.name,
                    `action=${preparation.action}`,
                    `image=${preparation.immutableReference}`,
                    excluded ? `excluded=${excluded}` : undefined,
                ],
                title: `Prepared ${workbench.manifest.name}`,
                details: [
                    preparation.action,
                    preparation.immutableReference,
                    excluded ? `${excluded} excluded` : undefined,
                ],
            });
        } finally {
            await runtime?.cleanup();
            await resolved.cleanup();
        }
    },
});
