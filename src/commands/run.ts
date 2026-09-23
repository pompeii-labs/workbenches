import { defineCommand } from 'citty';

import { createEventRenderer } from '../rendering/index.js';
import { parseRepository, RepositoryDeliveryStore } from '../repositories/index.js';
import { RunDispatcher, WorkbenchRun } from '../runs/index.js';
import { RuntimeSmoke } from '../runtimes/index.js';
import { workbenchHome } from '../storage.js';
import { launchWorkbenchTui } from '../tui.js';
import {
    WorkbenchEnvironment,
    WorkbenchPreflight,
    WorkbenchResolver,
    WorkbenchWorkspaces,
} from '../workbench/index.js';
import { CliInput } from './input.js';
import { CliPresenter } from './presenter.js';
import { CliRunClient } from './run-client.js';

export const runCommand = defineCommand({
    meta: {
        name: 'run',
        description: 'Run or interact with a Workbench.',
    },
    args: {
        workbench: {
            type: 'positional',
            description: 'Saved Workbench alias',
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
        'task-file': {
            type: 'string',
            description: 'Read the one-shot task from a UTF-8 file',
        },
        stdin: {
            type: 'boolean',
            description: 'Read the one-shot task from stdin',
            default: false,
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
            description: 'Workspace directory (defaults to the current directory)',
        },
        repo: {
            type: 'string',
            description:
                'Run in an isolated GitHub checkout with your GitHub credential',
        },
        ref: {
            type: 'string',
            description:
                'Repository branch, tag, or commit (defaults to its default branch)',
        },
        'env-file': {
            type: 'string',
            valueHint: 'path',
            description:
                'Load declared and provider environment bindings from a dotenv file',
        },
        env: {
            type: 'string',
            valueHint: 'NAME=value',
            description: 'Set a declared or provider environment binding (repeatable)',
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
        connection: {
            type: 'string',
            description: 'Use an authenticated provider connection for this run',
        },
    },
    async run({ args, rawArgs }) {
        rejectUnknownRunOptions(rawArgs);
        if (args.ref && !args.repo) throw new Error('--ref requires --repo');
        if (args.repo && args.dir)
            throw new Error('--repo and --dir cannot be combined');
        if (args.repo && args['dry-run'])
            throw new Error('Repository runs do not support --dry-run yet');
        if (args.repo) parseRepository(args.repo);
        const repository = args.repo
            ? {
                  repository: args.repo,
                  ...(args.ref ? { ref: args.ref } : {}),
              }
            : undefined;
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
        const taskSources = [
            args.prompt !== undefined,
            args.task !== undefined,
            args['task-file'] !== undefined,
            args.stdin,
        ].filter(Boolean).length;
        const task =
            taskSources === 0
                ? ''
                : await new CliInput().read({
                      text: args.task ?? args.prompt,
                      file: args['task-file'],
                      stdin: args.stdin,
                  });
        if (!task) {
            if (args.detach || args.json || args.final || args['dry-run']) {
                throw new Error('This run mode requires a non-empty task');
            }
            const resolved = await new WorkbenchResolver().resolve(args.workbench, {
                savedOnly: true,
                ...(args.dir ? { workspaceDirectory: args.dir } : {}),
            });
            if (repository) resolved.repository = repository;
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
                ...workbenchWorkspaces.environment(workspaces),
            };
            if (resolved.workbench.manifest.runtime === 'local') {
                new WorkbenchPreflight({ environment }).check(resolved.workbench);
            }
            await launchWorkbenchTui({
                initial: {
                    alias: args.workbench,
                    resolved,
                    ...(args.connection ? { connection: args.connection } : {}),
                },
                environment,
                workspaces,
                allowHostDocker: args['allow-host-docker'],
            });
            return;
        }
        if (args.detach && (args.final || args['dry-run'])) {
            throw new Error('--detach cannot be combined with --final or --dry-run');
        }

        const resolved = await new WorkbenchResolver().resolve(args.workbench, {
            savedOnly: true,
            ...(args.dir ? { workspaceDirectory: args.dir } : {}),
        });
        if (repository) resolved.repository = repository;
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
                        ...(args.connection ? { connection: args.connection } : {}),
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
                // E2B preparation creates a billable sandbox. The dispatched
                // worker performs the same preflight before startup completes.
                if (!repository && resolved.workbench.manifest.runtime !== 'e2b') {
                    const smoke = await new RuntimeSmoke({
                        workbench: resolved.workbench,
                        workspaceDirectory: resolved.workspaceDirectory,
                        environment,
                        workspaces,
                        allowHostDocker: args['allow-host-docker'],
                        reference: args.workbench,
                        home,
                        ...(args.connection ? { connection: args.connection } : {}),
                    }).check();
                    if (!smoke.authentication.ready) {
                        throw new Error(
                            `No authenticated route is available for ${smoke.authentication.model}. Run ${smoke.authentication.connectCommand}.`
                        );
                    }
                }
                const stored = await dispatcher.prepare({
                    resolved,
                    task,
                    mode: 'detached',
                    reference: args.workbench,
                    workspaces,
                    allowHostDocker: args['allow-host-docker'],
                    ...(args.connection ? { connection: args.connection } : {}),
                });
                await dispatcher.dispatch({
                    id: stored.id,
                    cwd: resolved.workspaceDirectory,
                    environment,
                    waitForInitialTurn: true,
                });
                console.log(
                    args.json
                        ? JSON.stringify({
                              session_id: stored.session_id ?? stored.id,
                              run_id: stored.id,
                              input_id: `input_${stored.id}`,
                              after_sequence: 0,
                          })
                        : (stored.session_id ?? stored.id)
                );
                return;
            }

            const stored = await dispatcher.prepare({
                resolved,
                task,
                mode: 'foreground',
                reference: args.workbench,
                workspaces,
                allowHostDocker: args['allow-host-docker'],
                ...(args.connection ? { connection: args.connection } : {}),
            });
            const renderer = createEventRenderer({
                mode: args.json ? 'json' : args.final ? 'final' : 'human',
                ...(args.color === undefined ? {} : { color: args.color }),
            });
            const handle = dispatcher.handle(stored.id);
            try {
                await dispatcher.dispatch({
                    id: stored.id,
                    cwd: resolved.workspaceDirectory,
                    environment,
                    waitForInitialTurn: true,
                });
                const client = new CliRunClient();
                const followed = await client.follow(handle, (event) =>
                    renderer.render(event)
                );
                if (followed.interrupted) {
                    process.exitCode = 130;
                    return;
                }
                if (followed.terminalStatus === 'failed') process.exitCode = 1;
                if (followed.terminalStatus === 'cancelled') process.exitCode = 130;
                if (
                    (await new RepositoryDeliveryStore(home).read(stored.id))?.state ===
                    'failed'
                )
                    process.exitCode = 1;
            } finally {
                renderer.finish();
            }
        } finally {
            await resolved.cleanup();
        }
    },
});

const runOptions = new Set([
    '--repo',
    '--ref',
    '--task',
    '-t',
    '--task-file',
    '--stdin',
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
    '--connection',
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
