import { defineCommand } from 'citty';

import { resolveReference } from '../references.js';
import { runWorkbench } from '../run.js';

export const runCommand = defineCommand({
    meta: {
        name: 'run',
        description: 'Run a task with a Workbench.',
    },
    args: {
        workbench: {
            type: 'positional',
            description: 'Saved alias or local Workbench reference',
            required: true,
        },
        task: {
            type: 'string',
            alias: 't',
            description: 'Task to send to the selected runner',
            required: true,
        },
        'dry-run': {
            type: 'boolean',
            description: 'Resolve and translate the run without launching it',
            default: false,
        },
        dir: {
            type: 'string',
            description:
                'Workspace directory (saved aliases default to the current directory)',
        },
    },
    async run({ args }) {
        const resolved = await resolveReference(args.workbench, {
            ...(args.dir ? { workspaceDirectory: args.dir } : {}),
        });
        try {
            const code = await runWorkbench({
                workbenchPath: resolved.workbench.packageDirectory,
                workspaceDirectory: resolved.workspaceDirectory,
                task: args.task,
                dryRun: args['dry-run'],
            });
            if (code !== 0) process.exitCode = code;
        } finally {
            await resolved.cleanup();
        }
    },
});
