import { autocomplete } from '@clack/prompts';
import { defineCommand } from 'citty';
import { SavedWorkbenchCatalog } from '../catalog/index.js';
import { RunnerCredentialStore } from '../connections/credentials.js';
import { ConnectionManager } from '../connections/manager.js';
import { ConnectionStore } from '../connections/store.js';
import { ModelRouter } from '../models/index.js';
import { RunnerRegistry } from '../runners/registry.js';
import type { PreparedRunner } from '../runners/runner.js';
import { runnerSetupError } from '../runners/setup.js';
import { RunStore } from '../runs/index.js';
import { type PreparedRuntime, RuntimeRegistry } from '../runtimes/index.js';
import { workbenchHome } from '../storage.js';
import {
    Workbench,
    WorkbenchEnvironment,
    WorkbenchResolver,
} from '../workbench/index.js';
import { CliPresenter } from './presenter.js';

export const connectCommand = defineCommand({
    meta: {
        name: 'connect',
        description: 'Manage reusable runner connections.',
    },
    args: {
        workbench: {
            type: 'positional',
            description: 'Saved alias or local Workbench reference',
            required: false,
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
    },
    async run({ args, rawArgs }) {
        const output = new CliPresenter();
        const workbenchEnvironment = new WorkbenchEnvironment();
        const overrides = await workbenchEnvironment.load({
            ...(args['env-file'] ? { envFile: args['env-file'] } : {}),
            rawArgs,
        });
        const home = workbenchHome();
        const reference = args.workbench ?? (await selectConnectionWorkbench(home));
        const resolved = await new WorkbenchResolver().resolve(reference, {
            home,
            ...(args.dir ? { workspaceDirectory: args.dir } : {}),
        });
        const environment = workbenchEnvironment.bind(resolved.workbench, overrides);
        let runner: PreparedRunner | undefined;
        let runtime: PreparedRuntime | undefined;
        let operationError: unknown;
        let connectedRecord: Parameters<CliPresenter['record']>[0] | undefined;
        try {
            output.progress('Checking available runner connections');
            runner = await RunnerRegistry.standard().prepare(
                resolved.workbench,
                environment
            );
            runtime = await RuntimeRegistry.standard()
                .resolve(resolved.workbench.manifest.runtime)
                .prepare({
                    workbench: resolved.workbench,
                    workspaceDirectory: resolved.workspaceDirectory,
                    environment,
                    assets: [
                        {
                            path: resolved.workspaceDirectory,
                            access: 'read-write',
                        },
                        {
                            path: resolved.workbench.packageDirectory,
                            access: 'read-only',
                        },
                        ...runner.assets,
                    ],
                    purpose: 'connect',
                    ...(resolved.workbench.manifest.runtime === 'e2b'
                        ? {
                              credentials: await new RunnerCredentialStore(
                                  home
                              ).prepare(
                                  resolved.workbench.manifest.runtime,
                                  resolved.workbench.manifest.runner
                              ),
                          }
                        : {}),
                    authorizations: { hostDocker: false },
                    run: {
                        id: RunStore.createId(),
                        scope: RunStore.scope(home),
                    },
                });
            try {
                await runtime.preflight();
            } catch (error) {
                throw runnerSetupError(error, resolved.workbench);
            }
            const status = await new ConnectionManager({
                workbench: resolved.workbench,
                runtime,
                runner,
                reference,
                home,
                announce: (message) => output.message(message, 'info', 'stderr'),
            }).configure();
            const configuration = status.configuration;
            if (!configuration) {
                throw new Error('The runner connection could not be resolved');
            }
            const connection = ConnectionManager.connectionLabel({
                provider: configuration.provider,
                nativeProvider: configuration.nativeProvider,
                nativeModel: configuration.model,
            });
            const runnerName = ConnectionManager.runnerLabel(
                resolved.workbench.manifest.runner
            );
            connectedRecord = {
                machine: [
                    'connected',
                    resolved.workbench.manifest.runtime,
                    resolved.workbench.manifest.runner,
                    configuration.provider,
                ],
                title: `Connected ${runnerName} in ${runtimeLabel(resolved.workbench.manifest.runtime)}`,
                details: [connection, 'Available to compatible Workbenches'],
            };
        } catch (error) {
            operationError = error;
        }
        const results = await Promise.allSettled([
            runtime?.cleanup(),
            runner?.cleanup(),
            resolved.cleanup(),
        ]);
        if (operationError) throw operationError;
        const failure = results.find(
            (result): result is PromiseRejectedResult => result.status === 'rejected'
        );
        if (failure) throw failure.reason;
        if (connectedRecord) output.record(connectedRecord);
    },
});

async function selectConnectionWorkbench(home: string): Promise<string> {
    const entries = await new SavedWorkbenchCatalog(home).list();
    if (entries.length === 0) {
        throw new Error(
            'No saved Workbenches are available to establish a runner connection. Pass a local Workbench path or save one first.'
        );
    }
    const targets = await Promise.all(
        entries.map(async (entry) => ({
            entry,
            workbench: await Workbench.load(entry.packagePath),
        }))
    );
    const store = new ConnectionStore(home);
    const environments = await Promise.all(
        groupConnectionEnvironments(targets).map(async (environment) => {
            const preferred = await store.find({
                runner: environment.runner,
                runtime: environment.runtime,
            });
            return {
                ...environment,
                preferred,
                reference: selectEnvironmentReference(environment.targets, preferred),
            };
        })
    );
    const only = environments[0];
    if (environments.length === 1 && only) return only.reference;
    if (!process.stdin.isTTY || !process.stderr.isTTY) {
        throw new Error(
            'wb connect requires a Workbench argument in a non-interactive terminal'
        );
    }
    const selection = await autocomplete<number>({
        message: 'Choose a runner environment to connect',
        placeholder: 'Search runner environments',
        maxItems: 7,
        options: environments.map((environment, index) => ({
            value: index,
            label: `${ConnectionManager.runnerLabel(environment.runner)} · ${runtimeLabel(environment.runtime)}`,
            ...(environment.preferred
                ? { hint: `default ${environment.preferred.nativeProvider}` }
                : {}),
        })),
    });
    if (typeof selection === 'symbol') throw new Error('Connection setup cancelled');
    const environment = environments[selection];
    if (!environment) throw new Error('A runner environment must be selected');
    return environment.reference;
}

function groupConnectionEnvironments(
    targets: Array<{
        entry: { alias: string; addedAt: string };
        workbench: Workbench;
    }>
): Array<{
    runner: string;
    runtime: string;
    targets: typeof targets;
}> {
    const grouped = new Map<string, (typeof targets)[number][]>();
    for (const target of targets) {
        const { runner, runtime } = target.workbench.manifest;
        const key = `${runner}\0${runtime}`;
        grouped.set(key, [...(grouped.get(key) ?? []), target]);
    }
    return [...grouped.values()]
        .map((members) => ({
            runner: members[0]?.workbench.manifest.runner ?? '',
            runtime: members[0]?.workbench.manifest.runtime ?? '',
            targets: members,
        }))
        .toSorted((left, right) =>
            `${left.runner}\0${left.runtime}`.localeCompare(
                `${right.runner}\0${right.runtime}`
            )
        );
}

function selectEnvironmentReference(
    targets: Array<{
        entry: { alias: string; addedAt: string };
        workbench: Workbench;
    }>,
    preferred?: { provider: string; nativeProvider: string }
): string {
    const router = new ModelRouter();
    const ordered = targets.toSorted((left, right) => {
        const routeDifference =
            availableProviderRoutes(router, right.workbench).length -
            availableProviderRoutes(router, left.workbench).length;
        return routeDifference || right.entry.addedAt.localeCompare(left.entry.addedAt);
    });
    const matching = preferred
        ? ordered.find((target) =>
              availableProviderRoutes(router, target.workbench).includes(
                  preferred.provider
              )
          )
        : undefined;
    const selected = matching ?? ordered[0];
    if (!selected) throw new Error('A runner environment must be selected');
    return selected.entry.alias;
}

function availableProviderRoutes(router: ModelRouter, workbench: Workbench): string[] {
    try {
        return router.routes(workbench).map((route) => route.provider);
    } catch {
        return workbench.manifest.model.routes?.map((route) => route.provider) ?? [];
    }
}

function runtimeLabel(runtime: string): string {
    if (runtime === 'e2b') return 'E2B';
    return runtime.charAt(0).toUpperCase() + runtime.slice(1);
}
