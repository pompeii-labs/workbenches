import { defineCommand } from 'citty';

import { preflightWorkbench } from '../preflight.js';
import { resolveReference } from '../references.js';
import { createEventRenderer } from '../render.js';
import { runWorkbench } from '../run.js';
import { updateStoredRun } from '../run-store.js';
import { workbenchHome } from '../storage.js';
import { dispatchStoredRun, executeStoredRun, prepareStoredRun } from '../worker.js';

export const runCommand = defineCommand({
    meta: {
        name: 'run',
        description: 'Run or interact with a Workbench.',
    },
    args: {
        workbench: {
            type: 'positional',
            description: 'Saved alias or local Workbench reference',
            required: true,
        },
        prompt: {
            type: 'positional',
            description: 'Optional one-shot task',
            required: false,
        },
        task: {
            type: 'string',
            alias: 't',
            description: 'One-shot task (equivalent to the positional task)',
        },
        json: {
            type: 'boolean',
            description: 'Emit normalized Workbench NDJSON events',
            default: false,
        },
        final: {
            type: 'boolean',
            description: 'Print only the final assistant response',
            default: false,
        },
        color: {
            type: 'boolean',
            description: 'Force color in human-readable output',
            negativeDescription: 'Disable color in human-readable output',
        },
        detach: {
            type: 'boolean',
            alias: 'd',
            description: 'Dispatch in the background and print only the run ID',
            default: false,
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
        if (args.prompt !== undefined && args.task !== undefined) {
            throw new Error('Pass a task either positionally or with --task, not both');
        }
        if (args.json && args.final) {
            throw new Error('--json and --final cannot be used together');
        }
        const task = (args.task ?? args.prompt ?? '').trim();
        if (!task) {
            if (args.detach || args.json || args.final || args['dry-run']) {
                throw new Error('This run mode requires a non-empty task');
            }
            throw new Error(
                'Interactive Workbench mode is not implemented yet. Pass a one-shot task as an argument or with --task.'
            );
        }
        if (args.detach && (args.json || args.final || args['dry-run'])) {
            throw new Error(
                '--detach cannot be combined with --json, --final, or --dry-run'
            );
        }

        const resolved = await resolveReference(args.workbench, {
            ...(args.dir ? { workspaceDirectory: args.dir } : {}),
        });
        try {
            if (args['dry-run']) {
                const code = await runWorkbench({
                    workbenchPath: resolved.workbench.packageDirectory,
                    workspaceDirectory: resolved.workspaceDirectory,
                    task,
                    dryRun: true,
                });
                if (code !== 0) process.exitCode = code;
                return;
            }

            const home = workbenchHome();
            if (args.detach) {
                preflightWorkbench(resolved.workbench);
                const stored = await prepareStoredRun({
                    home,
                    resolved,
                    task,
                    mode: 'detached',
                });
                try {
                    await dispatchStoredRun({
                        home,
                        id: stored.id,
                        cwd: resolved.workspaceDirectory,
                    });
                } catch (error) {
                    await updateStoredRun(home, stored.id, {
                        status: 'failed',
                        exit_code: 1,
                        finished_at: new Date().toISOString(),
                    });
                    throw error;
                }
                console.log(stored.id);
                return;
            }

            const stored = await prepareStoredRun({
                home,
                resolved,
                task,
                mode: 'foreground',
            });
            const renderer = createEventRenderer({
                mode: args.json ? 'json' : args.final ? 'final' : 'human',
                ...(args.color === undefined ? {} : { color: args.color }),
            });
            let code = 1;
            try {
                code = await executeStoredRun({
                    home,
                    id: stored.id,
                    render: (event) => renderer.render(event),
                });
            } finally {
                renderer.finish();
            }
            if (code !== 0) process.exitCode = code;
        } finally {
            await resolved.cleanup();
        }
    },
});
