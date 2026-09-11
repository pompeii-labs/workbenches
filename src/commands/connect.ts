import { defineCommand } from 'citty';
import { RunnerCredentialStore } from '../connections/credentials.js';
import { ConnectionManager } from '../connections/manager.js';
import { RunnerRegistry } from '../runners/registry.js';
import type { PreparedRunner } from '../runners/runner.js';
import { runnerSetupError } from '../runners/setup.js';
import { RunStore } from '../runs/index.js';
import { type PreparedRuntime, RuntimeRegistry } from '../runtimes/index.js';
import { workbenchHome } from '../storage.js';
import { WorkbenchEnvironment, WorkbenchResolver } from '../workbench/index.js';
import { CliPresenter } from './presenter.js';

export const connectCommand = defineCommand({
    meta: {
        name: 'connect',
        description: 'Choose a compatible runner connection for a Workbench.',
    },
    args: {
        workbench: {
            type: 'positional',
            description: 'Saved alias or local Workbench reference',
            required: true,
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
        const resolved = await new WorkbenchResolver().resolve(args.workbench, {
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
                reference: args.workbench,
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
                    resolved.workbench.manifest.name,
                    configuration.provider,
                    resolved.workbench.manifest.runner,
                ],
                title: `Connected ${resolved.workbench.manifest.name}`,
                details: [connection, runnerName],
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
