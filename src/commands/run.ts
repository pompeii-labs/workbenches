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
import { CliPresenter } from './presenter.js';

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
            description: 'Continue in the background and print the session ID',
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
                const output = new CliPresenter();
                let translation = '';
                let failure: string | undefined;
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
                        onEvent: (event) => {
                            if (event.type !== 'run.failed') return;
                            failure = string(object(event.data)?.message);
                        },
                    },
                    {
                        env: environment,
                        write: (value) => {
                            translation += value;
                        },
                    }
                );
                if (code !== 0) {
                    throw new Error(failure ?? 'Workbench dry run failed');
                }
                if (!translation.trim()) {
                    throw new Error('Workbench dry run returned no translation');
                }
                if (args.json || !output.interactive) {
                    process.stdout.write(translation);
                } else {
                    renderDryRun(output, translation, resolved);
                }
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
                console.log(stored.session_id ?? stored.id);
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

function renderDryRun(
    output: CliPresenter,
    source: string,
    resolved: Awaited<ReturnType<WorkbenchResolver['resolve']>>
): void {
    const value = JSON.parse(source) as Record<string, unknown>;
    const command = Array.isArray(value.command)
        ? value.command.filter((part): part is string => typeof part === 'string')
        : [];
    const route = object(value.model_route);
    output.record({
        machine: [],
        title: `Dry run ready for ${resolved.workbench.manifest.name}`,
        details: [
            resolved.workbench.manifest.runner,
            resolved.workbench.manifest.runtime,
        ],
        tone: 'info',
    });
    output.detail('Model', string(route?.canonical) ?? 'unknown');
    output.detail('Provider', string(route?.provider) ?? 'unknown');
    output.detail('Workspace', string(value.cwd) ?? resolved.workspaceDirectory);
    output.detail('Command', command.join(' ') || 'unavailable');
    output.detail(
        'Skills',
        Array.isArray(value.skills) ? String(value.skills.length) : 'unknown'
    );
    output.detail(
        'Workspaces',
        Array.isArray(value.workspaces) ? String(value.workspaces.length) : 'unknown'
    );
}

function object(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
}

function string(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined;
}
