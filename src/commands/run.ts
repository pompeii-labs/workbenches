import { defineCommand } from 'citty';

import { bindWorkbenchEnvironment, loadEnvironmentOverrides } from '../environment.js';
import { resolveReference } from '../references.js';
import { createEventRenderer } from '../render.js';
import { runWorkbench } from '../run.js';
import { updateStoredRun } from '../run-store.js';
import { smokeWorkbenchRuntime } from '../runtime.js';
import { workbenchHome } from '../storage.js';
import { launchWorkbenchTui } from '../tui.js';
import { dispatchStoredRun, executeStoredRun, prepareStoredRun } from '../worker.js';
import { bindWorkbenchWorkspaces, workspaceEnvironment } from '../workspaces.js';

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
        'env-file': {
            type: 'string',
            valueHint: 'path',
            description: 'Load declared environment bindings from a dotenv file',
        },
        env: {
            type: 'string',
            valueHint: 'NAME=value',
            description: 'Set a declared environment binding (repeatable)',
        },
        workspace: {
            type: 'string',
            valueHint: 'NAME=path',
            description: 'Bind a declared named workspace (repeatable)',
        },
        'allow-host-docker': {
            type: 'boolean',
            description: 'Authorize a declared host Docker engine binding for this run',
            default: false,
        },
    },
    async run({ args, rawArgs }) {
        if (args.prompt !== undefined && args.task !== undefined) {
            throw new Error('Pass a task either positionally or with --task, not both');
        }
        if (args.json && args.final) {
            throw new Error('--json and --final cannot be used together');
        }
        const overrides = await loadEnvironmentOverrides({
            ...(args['env-file'] ? { envFile: args['env-file'] } : {}),
            rawArgs,
        });
        const task = (args.task ?? args.prompt ?? '').trim();
        if (!task) {
            if (args.detach || args.json || args.final || args['dry-run']) {
                throw new Error('This run mode requires a non-empty task');
            }
            const resolved = await resolveReference(args.workbench, {
                ...(args.dir ? { workspaceDirectory: args.dir } : {}),
            });
            const workspaces = await bindWorkbenchWorkspaces({
                workbench: resolved.workbench,
                rawArgs,
            });
            validateHostDockerAuthorization(
                resolved.workbench.manifest.docker?.engine !== undefined,
                args['allow-host-docker']
            );
            await launchWorkbenchTui({
                initial: { alias: args.workbench, resolved },
                environment: {
                    ...bindWorkbenchEnvironment(resolved.workbench, overrides),
                    ...workspaceEnvironment(workspaces),
                },
                workspaces,
            });
            return;
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
            const workspaces = await bindWorkbenchWorkspaces({
                workbench: resolved.workbench,
                rawArgs,
            });
            validateHostDockerAuthorization(
                resolved.workbench.manifest.docker?.engine !== undefined,
                args['allow-host-docker']
            );
            const environment = bindWorkbenchEnvironment(resolved.workbench, overrides);
            if (args['dry-run']) {
                const code = await runWorkbench(
                    {
                        workbenchPath: resolved.workbench.packageDirectory,
                        workspaceDirectory: resolved.workspaceDirectory,
                        task,
                        dryRun: true,
                        workspaces,
                        allowHostDocker: args['allow-host-docker'],
                    },
                    { env: environment }
                );
                if (code !== 0) process.exitCode = code;
                return;
            }

            const home = workbenchHome();
            if (args.detach) {
                await smokeWorkbenchRuntime({
                    workbench: resolved.workbench,
                    workspaceDirectory: resolved.workspaceDirectory,
                    environment,
                    workspaces,
                    allowHostDocker: args['allow-host-docker'],
                });
                const stored = await prepareStoredRun({
                    home,
                    resolved,
                    task,
                    mode: 'detached',
                    workspaces,
                    allowHostDocker: args['allow-host-docker'],
                });
                try {
                    await dispatchStoredRun({
                        home,
                        id: stored.id,
                        cwd: resolved.workspaceDirectory,
                        environment,
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
                workspaces,
                allowHostDocker: args['allow-host-docker'],
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
                    environment,
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

function validateHostDockerAuthorization(declared: boolean, authorized: boolean): void {
    if (authorized && !declared) {
        throw new Error(
            '--allow-host-docker requires a Workbench that declares docker.engine'
        );
    }
}
