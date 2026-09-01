import { defineCommand } from 'citty';

import { createEventRenderer } from '../rendering/index.js';
import {
    RunDispatcher,
    RunWorker,
    type WorkbenchEvent,
    WorkbenchRun,
} from '../runs/index.js';
import { RuntimeSmoke } from '../runtimes/index.js';
import { workbenchHome } from '../storage.js';
import { launchWorkbenchTui } from '../tui.js';
import {
    WorkbenchEnvironment,
    WorkbenchResolver,
    WorkbenchWorkspaces,
} from '../workbench/index.js';

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
        rejectUnknownRunOptions(rawArgs);
        if (args.prompt !== undefined && args.task !== undefined) {
            throw new Error('Pass a task either positionally or with --task, not both');
        }
        if (args.json && args.final) {
            throw new Error('--json and --final cannot be used together');
        }
        const workbenchEnvironment = new WorkbenchEnvironment();
        const workbenchWorkspaces = new WorkbenchWorkspaces();
        const overrides = await workbenchEnvironment.load({
            ...(args['env-file'] ? { envFile: args['env-file'] } : {}),
            rawArgs,
        });
        const home = workbenchHome();
        const dispatcher = new RunDispatcher(home);
        const worker = new RunWorker(home);
        const task = (args.task ?? args.prompt ?? '').trim();
        if (!task) {
            if (args.detach || args.json || args.final || args['dry-run']) {
                throw new Error('This run mode requires a non-empty task');
            }
            const resolved = await new WorkbenchResolver().resolve(args.workbench, {
                ...(args.dir ? { workspaceDirectory: args.dir } : {}),
            });
            const workspaces = await workbenchWorkspaces.bind({
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
                    ...process.env,
                    ...workbenchEnvironment.bind(resolved.workbench, overrides),
                    ...workbenchWorkspaces.environment(workspaces),
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

        const resolved = await new WorkbenchResolver().resolve(args.workbench, {
            ...(args.dir ? { workspaceDirectory: args.dir } : {}),
        });
        try {
            const workspaces = await workbenchWorkspaces.bind({
                workbench: resolved.workbench,
                rawArgs,
            });
            validateHostDockerAuthorization(
                resolved.workbench.manifest.docker?.engine !== undefined,
                args['allow-host-docker']
            );
            const environment = {
                ...process.env,
                ...workbenchEnvironment.bind(resolved.workbench, overrides),
            };
            if (args['dry-run']) {
                const code = await WorkbenchRun.execute(
                    {
                        workbenchPath: resolved.workbench.packageDirectory,
                        workspaceDirectory: resolved.workspaceDirectory,
                        task,
                        dryRun: true,
                        workspaces,
                        allowHostDocker: args['allow-host-docker'],
                        reference: args.workbench,
                        home,
                    },
                    { env: environment }
                );
                if (code !== 0) process.exitCode = code;
                return;
            }

            if (args.detach) {
                const smoke = await new RuntimeSmoke({
                    workbench: resolved.workbench,
                    workspaceDirectory: resolved.workspaceDirectory,
                    environment,
                    workspaces,
                    allowHostDocker: args['allow-host-docker'],
                    reference: args.workbench,
                    home,
                }).check();
                if (!smoke.authentication.ready) {
                    throw new Error(
                        `No authenticated route is available for ${smoke.authentication.model}. Run ${smoke.authentication.connectCommand}.`
                    );
                }
                const stored = await dispatcher.prepare({
                    resolved,
                    task,
                    mode: 'detached',
                    reference: args.workbench,
                    workspaces,
                    allowHostDocker: args['allow-host-docker'],
                });
                await dispatcher.dispatch({
                    id: stored.id,
                    cwd: resolved.workspaceDirectory,
                    environment,
                });
                console.log(stored.id);
                return;
            }

            const stored = await dispatcher.prepare({
                resolved,
                task,
                mode: 'foreground',
                reference: args.workbench,
                workspaces,
                allowHostDocker: args['allow-host-docker'],
            });
            const renderer = createEventRenderer({
                mode: args.json ? 'json' : args.final ? 'final' : 'human',
                ...(args.color === undefined ? {} : { color: args.color }),
            });
            const handle = dispatcher.handle(stored.id);
            const rendering = renderEvents(handle.events, (event) =>
                renderer.render(event)
            );
            let code = 1;
            try {
                code = await worker.execute({
                    id: stored.id,
                    environment,
                });
                await rendering;
            } finally {
                renderer.finish();
            }
            if (code !== 0) process.exitCode = code;
        } finally {
            await resolved.cleanup();
        }
    },
});

async function renderEvents(
    events: AsyncIterable<WorkbenchEvent>,
    render: (event: WorkbenchEvent) => void
): Promise<void> {
    for await (const event of events) render(event);
}

const runOptions = new Set([
    '--task',
    '-t',
    '--json',
    '--final',
    '--color',
    '--no-color',
    '--detach',
    '-d',
    '--dry-run',
    '--dir',
    '--env-file',
    '--env',
    '--workspace',
    '--allow-host-docker',
]);

function rejectUnknownRunOptions(rawArgs: string[]): void {
    for (const argument of rawArgs) {
        if (argument === '--') return;
        if (!argument.startsWith('-') || argument === '-') continue;
        const name = argument.includes('=') ? argument.split('=', 1)[0] : argument;
        if (!name || !runOptions.has(name)) {
            throw new Error(`Unknown run option: ${name ?? argument}`);
        }
    }
}

function validateHostDockerAuthorization(declared: boolean, authorized: boolean): void {
    if (authorized && !declared) {
        throw new Error(
            '--allow-host-docker requires a Workbench that declares docker.engine'
        );
    }
}
