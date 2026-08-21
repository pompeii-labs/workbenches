import { basename } from 'node:path';

import { defineCommand } from 'citty';

import { findCatalogEntry, readCatalog } from '../catalog.js';
import { bindWorkbenchEnvironment, loadEnvironmentOverrides } from '../environment.js';
import { fetchGitHubWorkbenches, resolvedRemoteWorkbench } from '../github.js';
import { resolveReference } from '../references.js';
import { smokeWorkbenchRuntime } from '../runtime.js';
import {
    discoverWorkbenches,
    parseWorkbenchReference,
    resolveLocalSource,
} from '../source.js';
import { workbenchHome } from '../storage.js';
import { bindWorkbenchWorkspaces } from '../workspaces.js';

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
        const overrides = await loadEnvironmentOverrides({
            ...(args['env-file'] ? { envFile: args['env-file'] } : {}),
            rawArgs,
        });
        const home = workbenchHome();
        const saved = !args.source.includes('/')
            ? findCatalogEntry(await readCatalog(home), args.source)
            : undefined;
        if (saved) {
            const resolved = await resolveReference(args.source, { home });
            const workspaces = await bindWorkbenchWorkspaces({
                workbench: resolved.workbench,
                rawArgs,
            });
            validateHostDockerAuthorization(
                resolved.workbench,
                args['allow-host-docker']
            );
            await printResult(
                resolved.workbench.manifest.name,
                smokeWorkbenchRuntime({
                    workbench: resolved.workbench,
                    workspaceDirectory: resolved.workspaceDirectory,
                    environment: bindWorkbenchEnvironment(
                        resolved.workbench,
                        overrides
                    ),
                    workspaces,
                    allowHostDocker: args['allow-host-docker'],
                })
            );
            return;
        }
        const reference = parseWorkbenchReference(args.source);
        const local = await resolveLocalSource(reference.source);
        if (local) {
            const workbenches = await discoverWorkbenches(local.directory);
            const selected = reference.selector
                ? workbenches.filter(
                      (workbench) =>
                          basename(workbench.packageDirectory) === reference.selector ||
                          workbench.manifest.name === reference.selector
                  )
                : workbenches;
            if (selected.length === 0) throw new Error('No matching Workbenches found');
            for (const workbench of selected) {
                const workspaces = await bindWorkbenchWorkspaces({
                    workbench,
                    rawArgs,
                });
                validateHostDockerAuthorization(workbench, args['allow-host-docker']);
                await printResult(
                    workbench.manifest.name,
                    smokeWorkbenchRuntime({
                        workbench,
                        environment: bindWorkbenchEnvironment(workbench, overrides),
                        workspaces,
                        allowHostDocker: args['allow-host-docker'],
                    })
                );
            }
            return;
        }
        const workbenches = await fetchGitHubWorkbenches(
            reference.source,
            reference.selector
        );
        if (workbenches.length === 0) throw new Error('No matching Workbenches found');
        for (const workbench of workbenches) {
            const resolved = resolvedRemoteWorkbench(workbench);
            const workspaces = await bindWorkbenchWorkspaces({
                workbench: resolved,
                rawArgs,
            });
            validateHostDockerAuthorization(resolved, args['allow-host-docker']);
            await printResult(
                workbench.manifest.name,
                smokeWorkbenchRuntime({
                    workbench: resolved,
                    environment: bindWorkbenchEnvironment(resolved, overrides),
                    workspaces,
                    allowHostDocker: args['allow-host-docker'],
                })
            );
        }
    },
});

async function printResult(
    name: string,
    pending: ReturnType<typeof smokeWorkbenchRuntime>
) {
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
    console.log(
        `ready\t${name}\trunner=${result.runner.path}\ttools=${result.tools.map((tool) => tool.path).join(',') || '-'}${workspaces}${dockerEngine}${disabled}`
    );
}

function validateHostDockerAuthorization(
    workbench: Parameters<typeof bindWorkbenchEnvironment>[0],
    authorized: boolean
): void {
    if (authorized && !workbench.manifest.docker?.engine) {
        throw new Error(
            '--allow-host-docker requires a Workbench that declares docker.engine'
        );
    }
}
