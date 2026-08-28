import { basename } from 'node:path';

import { defineCommand } from 'citty';

import { SavedWorkbenchCatalog } from '../catalog/index.js';
import { RuntimeSmoke, type WorkbenchSmokeResult } from '../runtimes/index.js';
import { GitHubWorkbenchSource } from '../sources/index.js';
import { workbenchHome } from '../storage.js';
import type { ResolvedWorkbench } from '../types.js';
import {
    WorkbenchEnvironment,
    WorkbenchResolver,
    WorkbenchSource,
    WorkbenchWorkspaces,
} from '../workbench/index.js';

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
            description:
                'Authorize a declared host Docker engine binding for this smoke',
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
            const workspaces = await workbenchWorkspaces.bind({
                workbench: resolved.workbench,
                rawArgs,
            });
            validateHostDockerAuthorization(
                resolved.workbench,
                args['allow-host-docker']
            );
            await printResult(
                resolved.workbench.manifest.name,
                new RuntimeSmoke({
                    workbench: resolved.workbench,
                    workspaceDirectory: resolved.workspaceDirectory,
                    environment: workbenchEnvironment.bind(
                        resolved.workbench,
                        overrides
                    ),
                    workspaces,
                    allowHostDocker: args['allow-host-docker'],
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
            const workbenches = await source.discover(local.directory);
            const selected = reference.selector
                ? workbenches.filter(
                      (workbench) =>
                          basename(workbench.packageDirectory) === reference.selector ||
                          workbench.manifest.name === reference.selector
                  )
                : workbenches;
            if (selected.length === 0) throw new Error('No matching Workbenches found');
            for (const workbench of selected) {
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
            const resolved = github.resolve(workbench);
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
                    reference: args.source,
                    home,
                }).check()
            );
        }
    },
});

async function printResult(name: string, pending: Promise<WorkbenchSmokeResult>) {
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
    const authentication = result.authentication.ready
        ? `; auth: ready (${result.authentication.configuration?.provider ?? 'environment'})`
        : `; auth: required (${result.authentication.connectCommand})`;
    console.log(
        `${result.authentication.ready ? 'ready' : 'needs-auth'}\t${name}\trunner=${result.runner.path}\ttools=${result.tools.map((tool) => tool.path).join(',') || '-'}${authentication}${workspaces}${dockerEngine}${disabled}`
    );
    if (!result.authentication.ready) process.exitCode = 1;
}

function validateHostDockerAuthorization(
    workbench: ResolvedWorkbench,
    authorized: boolean
): void {
    if (authorized && !workbench.manifest.docker?.engine) {
        throw new Error(
            '--allow-host-docker requires a Workbench that declares docker.engine'
        );
    }
}
