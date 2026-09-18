import { defineCommand } from 'citty';

import { WorkbenchAuthoring } from '../authoring/index.js';
import { AuthoringJob } from '../authoring/job.js';
import { RunStore } from '../runs/store.js';
import { workbenchHome } from '../storage.js';
import { assertWorkbenchTuiSupported, launchWorkbenchTui } from '../tui.js';
import { WorkbenchEnvironment, WorkbenchWorkspaces } from '../workbench/index.js';
import { CliInput } from './input.js';
import { CliWait } from './waiting.js';

export const createCommand = defineCommand({
    meta: {
        name: 'create',
        description: 'Create, edit, or improve a Workbench with the official creator.',
    },
    args: {
        target: {
            type: 'positional',
            description: 'New Workbench name or existing local Workbench reference',
            required: false,
        },
        dir: {
            type: 'string',
            description: 'Repository to author in (defaults to the current directory)',
        },
        from: {
            type: 'string',
            description:
                'Session or run ID whose evidence should improve its Workbench',
        },
        feedback: {
            type: 'string',
            description: 'Maintainer feedback to include with --from evidence',
        },
        task: {
            type: 'string',
            alias: 't',
            description: 'Authoring brief for non-interactive use',
        },
        'task-file': {
            type: 'string',
            description: 'Read the authoring brief from a UTF-8 file',
        },
        stdin: {
            type: 'boolean',
            description: 'Read the authoring brief from stdin',
            default: false,
        },
        detach: {
            type: 'boolean',
            alias: 'd',
            description: 'Start headless authoring in the background',
            default: false,
        },
        json: {
            type: 'boolean',
            description: 'Print one headless launch receipt or verified result',
            default: false,
        },
        'env-file': {
            type: 'string',
            valueHint: 'path',
            description: 'Load candidate environment bindings from a dotenv file',
        },
        env: {
            type: 'string',
            valueHint: 'NAME=value',
            description: 'Set a candidate environment binding (repeatable)',
        },
        workspace: {
            type: 'string',
            valueHint: 'NAME=path',
            description: 'Bind a candidate named workspace (repeatable)',
        },
        'allow-host-docker': {
            type: 'boolean',
            description:
                'Authorize a candidate host Docker engine binding during smoke',
            default: false,
        },
    },
    async run({ args, rawArgs }) {
        const hasInput =
            args.task !== undefined || args['task-file'] !== undefined || args.stdin;
        const headless = hasInput || args.detach || args.json;
        if (!headless) assertWorkbenchTuiSupported();
        if (headless && !hasInput && !args.from)
            throw new Error(
                'Headless authoring requires --task, --task-file, or --stdin; --from can infer improvements from session evidence'
            );
        const brief = hasInput
            ? await new CliInput().read({
                  text: args.task,
                  file: args['task-file'],
                  stdin: args.stdin,
              })
            : undefined;
        const environmentOverrides = await new WorkbenchEnvironment().load({
            ...(args['env-file'] ? { envFile: args['env-file'] } : {}),
            rawArgs,
        });
        const workspaceOverrides = new WorkbenchWorkspaces().parse(rawArgs);
        const home = workbenchHome();
        const launch = await new WorkbenchAuthoring(home, {
            verification: {
                environment: process.env,
                environmentOverrides,
                workspaceOverrides,
                workspaceDirectory: process.cwd(),
                ...(args['allow-host-docker'] ? { allowHostDocker: true } : {}),
            },
        }).create({
            ...(args.target ? { target: args.target } : {}),
            ...(args.dir ? { directory: args.dir } : {}),
            ...(args.from ? { from: args.from } : {}),
            ...(args.feedback ? { feedback: args.feedback } : {}),
        });
        if (headless) {
            try {
                const prompt = [launch.prompt, brief].filter(Boolean).join('\n\n');
                const job = await new AuthoringJob(home).start(launch, prompt, {
                    detached: args.detach,
                });
                if (args.detach) {
                    process.stdout.write(
                        args.json
                            ? `${JSON.stringify({ session_id: job.session_id, run_id: job.run_id, operation_id: job.operation_id, input_id: `input_${job.run_id}`, after_sequence: 0 })}\n`
                            : `${job.session_id}\n`
                    );
                } else {
                    await new CliWait().execute(
                        home,
                        await new RunStore(home).read(job.run_id),
                        { json: args.json }
                    );
                }
            } finally {
                await launch.resolved.cleanup();
            }
            return;
        }
        await launchWorkbenchTui({
            initial: {
                alias: launch.alias,
                resolved: launch.resolved,
                ...(launch.prompt ? { prompt: launch.prompt } : {}),
                operation: launch.operation,
                environment: launch.environment,
            },
            environment: process.env,
        });
    },
});
