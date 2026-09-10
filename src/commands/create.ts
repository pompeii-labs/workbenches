import { defineCommand } from 'citty';

import { WorkbenchAuthoring } from '../authoring/index.js';
import { workbenchHome } from '../storage.js';
import { assertWorkbenchTuiSupported, launchWorkbenchTui } from '../tui.js';
import { WorkbenchEnvironment, WorkbenchWorkspaces } from '../workbench/index.js';

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
        assertWorkbenchTuiSupported();
        const environmentOverrides = await new WorkbenchEnvironment().load({
            ...(args['env-file'] ? { envFile: args['env-file'] } : {}),
            rawArgs,
        });
        const workspaceOverrides = new WorkbenchWorkspaces().parse(rawArgs);
        const launch = await new WorkbenchAuthoring(workbenchHome(), {
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
