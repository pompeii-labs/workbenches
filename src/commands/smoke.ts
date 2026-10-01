import { defineCommand } from 'citty';

import { SavedWorkbenchCatalog } from '../catalog/index.js';
import { RuntimeSmoke, type WorkbenchSmokeResult } from '../runtimes/index.js';
import { GitHubWorkbenchSource } from '../sources/index.js';
import { workbenchHome } from '../storage.js';
import type { ResolvedWorkbench } from '../types.js';
import {
    selectedRuntime,
    WorkbenchEnvironment,
    WorkbenchResolver,
    WorkbenchSource,
    WorkbenchWorkspaces,
    withRuntime,
} from '../workbench/index.js';
import { CliPresenter } from './presenter.js';

export const smokeCommand = defineCommand({
    meta: {
        name: 'smoke',
        description: 'Verify a Workbench can start without spending model tokens.',
    },
    args: {
        source: {
            type: 'positional',
            description: 'Workbench reference or source',
            default: '.',
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
            description:
                'Authorize a declared host Docker engine binding for this smoke',
            default: false,
        },
        runtime: {
            type: 'string',
            valueHint: 'name',
            description:
                'Declared runtime to check (defaults to the first declared runtime)',
        },
        'allow-unchecked-gpu': {
            type: 'boolean',
            description: 'Accept a GPU requirement on a runtime that cannot check it',
            default: false,
        },
    },
    async run({ args, rawArgs }) {
        const workbenchEnvironment = new WorkbenchEnvironment();
        const workbenchWorkspaces = new WorkbenchWorkspaces();
        const overrides = await workbenchEnvironment.load({
            ...(args['env-file'] ? { envFile: args['env-file'] } : {}),
            rawArgs,
        });
        const home = workbenchHome();
        const saved = !args.source.includes('/')
            ? await new SavedWorkbenchCatalog(home).find(args.source)
            : undefined;
        if (saved) {
            const resolved = await new WorkbenchResolver().resolve(args.source, {
                home,
            });
            const workbench = withRuntime(resolved.workbench, args.runtime);
            const workspaces = await workbenchWorkspaces.bind({
                workbench,
                rawArgs,
            });
            validateHostDockerAuthorization(workbench, args['allow-host-docker']);
            await printResult(
                workbench.manifest.name,
                new RuntimeSmoke({
                    workbench,
                    workspaceDirectory: resolved.workspaceDirectory,
                    environment: workbenchEnvironment.bind(workbench, overrides),
                    workspaces,
                    allowHostDocker: args['allow-host-docker'],
                    allowUncheckedGpu: args['allow-unchecked-gpu'],
                    reference: args.source,
                    home,
                }).check()
            );
            return;
        }
        const source = new WorkbenchSource();
        const reference = source.parse(args.source);
        const local = await source.local(reference.source);
        if (local) {
            const selected = reference.selector
                ? [await source.select(local.directory, reference.selector)]
                : await source.discover(local.directory);
            if (selected.length === 0) throw new Error('No matching Workbenches found');
            for (const candidate of selected) {
                const workbench = withRuntime(candidate, args.runtime);
                const workspaces = await workbenchWorkspaces.bind({
                    workbench,
                    rawArgs,
                });
                validateHostDockerAuthorization(workbench, args['allow-host-docker']);
                await printResult(
                    workbench.manifest.name,
                    new RuntimeSmoke({
                        workbench,
                        environment: workbenchEnvironment.bind(workbench, overrides),
                        workspaces,
                        allowHostDocker: args['allow-host-docker'],
                        allowUncheckedGpu: args['allow-unchecked-gpu'],
                        reference: args.source,
                        home,
                    }).check()
                );
            }
            return;
        }
        const github = new GitHubWorkbenchSource();
        const workbenches = await github.fetchAll(reference.source, reference.selector);
        if (workbenches.length === 0) throw new Error('No matching Workbenches found');
        for (const workbench of workbenches) {
            const resolved = withRuntime(github.resolve(workbench), args.runtime);
            const workspaces = await workbenchWorkspaces.bind({
                workbench: resolved,
                rawArgs,
            });
            validateHostDockerAuthorization(resolved, args['allow-host-docker']);
            await printResult(
                workbench.manifest.name,
                new RuntimeSmoke({
                    workbench: resolved,
                    environment: workbenchEnvironment.bind(resolved, overrides),
                    workspaces,
                    allowHostDocker: args['allow-host-docker'],
                    allowUncheckedGpu: args['allow-unchecked-gpu'],
                    reference: args.source,
                    home,
                }).check()
            );
        }
    },
});

async function printResult(name: string, pending: Promise<WorkbenchSmokeResult>) {
    const output = new CliPresenter();
    output.progress(`Checking ${name}`);
    const result = await pending;
    const disabled = result.disabledMcps.length
        ? `; optional MCPs disabled: ${result.disabledMcps.join(', ')}`
        : '';
    const workspaces = result.workspaces.length
        ? `; workspaces: ${result.workspaces.map((workspace) => `${workspace.name}=${workspace.path} (${workspace.access})`).join(', ')}`
        : '';
    const dockerEngine = result.dockerEngine
        ? `; docker-engine: ${result.dockerEngine}`
        : '';
    const requirements = [
        ...(result.requirements?.applied ?? []).map((entry) => `applied ${entry}`),
        ...(result.requirements?.unchecked ?? []).map((entry) => `unchecked: ${entry}`),
    ];
    const unchecked = requirements.length
        ? `; requirements: ${requirements.join(', ')}`
        : '';
    const authentication = result.authentication.ready
        ? `; auth: ready (${result.authentication.configuration?.provider ?? 'environment'})`
        : `; auth: required (${result.authentication.connectCommand})`;
    const status = result.authentication.ready ? 'ready' : 'needs-auth';
    output.record({
        machine: [
            status,
            name,
            `runner=${result.runner.path}`,
            `tools=${result.tools.map((tool) => tool.path).join(',') || '-'}${authentication}${workspaces}${dockerEngine}${unchecked}${disabled}`,
        ],
        title: result.authentication.ready
            ? `${name} is ready`
            : `${name} needs a connection`,
        details: [
            result.runner.path,
            result.tools.length > 0
                ? `${result.tools.length} ${result.tools.length === 1 ? 'tool' : 'tools'}`
                : 'no required tools',
            result.authentication.ready
                ? `auth ${result.authentication.configuration?.provider ?? 'environment'}`
                : result.authentication.connectCommand,
            ...requirements,
        ],
        tone: result.authentication.ready ? 'success' : 'warning',
    });
    if (!result.authentication.ready) process.exitCode = 1;
}

function validateHostDockerAuthorization(
    workbench: ResolvedWorkbench,
    authorized: boolean
): void {
    if (authorized && !selectedRuntime(workbench).docker?.engine) {
        throw new Error(
            '--allow-host-docker requires a Workbench that declares docker.engine'
        );
    }
}
