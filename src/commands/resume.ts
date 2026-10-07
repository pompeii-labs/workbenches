import { defineCommand } from 'citty';

import { createEventRenderer } from '../rendering/index.js';
import { RepositoryDeliveryStore } from '../repositories/receipts.js';
import { RunContinuation } from '../runs/index.js';
import { SessionResolver } from '../sessions/index.js';
import { workbenchHome } from '../storage.js';
import { selectedRuntime, WorkbenchEnvironment } from '../workbench/index.js';
import { CliInput } from './input.js';
import { CliRunClient } from './run-client.js';

export const resumeCommand = defineCommand({
    meta: {
        name: 'resume',
        description: 'Continue a resumable Workbench session.',
    },
    args: {
        session: {
            type: 'positional',
            description: 'Workbench session ID',
            required: true,
        },
        prompt: {
            type: 'positional',
            description: 'Optional task to send',
            required: false,
        },
        task: {
            type: 'string',
            alias: 't',
            description: 'Task to send (equivalent to the positional task)',
        },
        'task-file': {
            type: 'string',
            description: 'Read the task from a UTF-8 file',
        },
        stdin: {
            type: 'boolean',
            description: 'Read the task from stdin',
            default: false,
        },
        detach: {
            type: 'boolean',
            alias: 'd',
            description: 'Continue in the background and print the session ID',
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
        'allow-host-docker': {
            type: 'boolean',
            description: 'Allow this Workbench to access the host Docker daemon',
            default: false,
        },
        connection: {
            type: 'string',
            description:
                'Use an authenticated provider connection for the next execution',
        },
    },
    async run({ args, rawArgs }) {
        if (args.json && args.final) {
            throw new Error('--json and --final cannot be used together');
        }
        const hasInput =
            args.prompt !== undefined ||
            args.task !== undefined ||
            args['task-file'] !== undefined ||
            args.stdin;
        const task = hasInput
            ? await new CliInput().read({
                  text: args.task ?? args.prompt,
                  file: args['task-file'],
                  stdin: args.stdin,
              })
            : '';
        const home = workbenchHome();
        const target = await new SessionResolver(home).resolve(args.session);
        const workbenchEnvironment = new WorkbenchEnvironment();
        const overrides = await workbenchEnvironment.load({
            ...(args['env-file'] ? { envFile: args['env-file'] } : {}),
            rawArgs,
        });
        const environment = workbenchEnvironment.bind(
            target.resolved.workbench,
            overrides
        );
        if (
            selectedRuntime(target.resolved.workbench).docker?.engine &&
            !args['allow-host-docker']
        ) {
            throw new Error(
                'This Workbench requests host Docker engine access. Re-run with --allow-host-docker to authorize it.'
            );
        }
        if (!task) {
            throw new Error(
                `Session ${target.session.id} needs new input. Use wb send ${target.session.id} <task> or pass --task, --task-file, or --stdin.`
            );
        }
        if (args.detach && args.final) {
            throw new Error('--detach cannot be combined with --final');
        }
        const continuation = await new RunContinuation(home).submit({
            resolved: target.resolved,
            session: target.session,
            task,
            mode: args.detach ? 'detached' : 'foreground',
            environment,
            environmentOverrides: Boolean(
                args['env-file'] || overrides.explicit.size > 0
            ),
            workspaces: target.session.workspaces,
            allowHostDocker: args['allow-host-docker'],
            ...(args.connection ? { connection: args.connection } : {}),
        });
        if (args.detach) {
            console.log(
                args.json
                    ? JSON.stringify({
                          session_id: target.session.id,
                          run_id: continuation.run.id,
                          input_id: continuation.inputId,
                          after_sequence: continuation.afterSequence,
                          ...(continuation.receipt
                              ? { receipt: continuation.receipt }
                              : {}),
                      })
                    : target.session.id
            );
            return;
        }
        const renderer = createEventRenderer({
            mode: args.json ? 'json' : args.final ? 'final' : 'human',
            ...(args.color === undefined ? {} : { color: args.color }),
        });
        let followed: Awaited<ReturnType<CliRunClient['followInput']>>;
        try {
            followed = await new CliRunClient().followInput(
                continuation.handle,
                continuation.inputId,
                (event) => renderer.render(event),
                continuation.afterSequence,
                continuation.receipt === undefined
            );
        } finally {
            renderer.finish();
        }
        if (followed.interrupted) {
            process.exitCode = 130;
            return;
        }
        if (followed.terminalStatus === 'failed') {
            process.exitCode = followed.failureExitCode ?? 1;
        } else if (followed.terminalStatus === 'cancelled') {
            process.exitCode = 130;
        } else if (!followed.reachedBoundary) {
            throw new Error(
                `Session ${target.session.id} ended before completing the task`
            );
        }
        if (
            (await new RepositoryDeliveryStore(home).read(continuation.run.id))
                ?.state === 'failed'
        )
            process.exitCode = 1;
    },
});
