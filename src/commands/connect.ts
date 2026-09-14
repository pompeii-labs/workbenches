import { autocomplete, type Option, select } from '@clack/prompts';
import { defineCommand } from 'citty';
import { RunnerCredentialStore } from '../connections/credentials.js';
import { ConnectionManager } from '../connections/manager.js';
import { prepareConnectionSetupWorkbench } from '../connections/setup-workbench.js';
import {
    type ConnectionTarget,
    connectionAuthenticationMethods,
    connectionHarnesses,
    connectionProviders,
    connectionRuntimes,
    harnessLabel,
    runtimeLabel,
} from '../connections/targets.js';
import { ModelCatalog } from '../models/catalog.js';
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
        runtime: {
            type: 'string',
            description: 'Connection runtime: local, docker, or e2b',
        },
        harness: {
            type: 'string',
            description: 'Agent harness: opencode or pi',
        },
        provider: {
            type: 'string',
            description: 'Model provider to authenticate',
        },
        method: {
            type: 'string',
            description: 'Authentication method for the selected provider',
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
        const target = args.workbench
            ? undefined
            : await selectConnectionTarget({
                  ...(args.runtime ? { runtime: args.runtime } : {}),
                  ...(args.harness ? { harness: args.harness } : {}),
                  ...(args.provider ? { provider: args.provider } : {}),
                  ...(args.method ? { method: args.method } : {}),
              });
        const reference = target
            ? connectionReference(target)
            : (args.workbench as string);
        const resolved = target
            ? await prepareConnectionSetupWorkbench(target)
            : await new WorkbenchResolver().resolve(reference, {
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
                ...(target
                    ? {
                          authentication: {
                              provider: target.provider,
                              nativeProvider: target.method.nativeProvider,
                              ...(target.method.nativeMethod
                                  ? { nativeMethod: target.method.nativeMethod }
                                  : {}),
                              authenticationMethod: target.method.authenticationMethod,
                              label: target.method.label,
                          },
                      }
                    : {}),
            }).configure();
            const configuration = status.configuration;
            if (!configuration) {
                throw new Error('The runner connection could not be resolved');
            }
            const connection = ConnectionManager.connectionLabel({
                provider: configuration.provider,
                nativeProvider: configuration.nativeProvider,
                nativeModel: configuration.model,
                ...(target
                    ? {
                          authenticationMethod: target.method.authenticationMethod,
                      }
                    : {}),
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
                details: [
                    connection,
                    ...(target ? [target.method.label] : []),
                    'Available to compatible Workbenches',
                ],
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

async function selectConnectionTarget(input: {
    runtime?: string;
    harness?: string;
    provider?: string;
    method?: string;
}): Promise<ConnectionTarget> {
    const interactive = process.stdin.isTTY && process.stderr.isTTY;
    const runtime = await chooseOption({
        ...(input.runtime ? { provided: input.runtime } : {}),
        values: [...connectionRuntimes],
        interactive,
        message: 'Choose a runtime',
        labels: Object.fromEntries(
            connectionRuntimes.map((value) => [value, runtimeLabel(value)])
        ),
        hints: {
            local: 'this machine',
            docker: 'local container',
            e2b: 'cloud sandbox',
        },
        flag: '--runtime',
    });
    const harness = await chooseOption({
        ...(input.harness ? { provided: input.harness } : {}),
        values: [...connectionHarnesses],
        interactive,
        message: 'Choose a harness',
        labels: Object.fromEntries(
            connectionHarnesses.map((value) => [value, harnessLabel(value)])
        ),
        flag: '--harness',
    });
    const catalog = ModelCatalog.current();
    const providers = connectionProviders(harness, catalog);
    const provider = await chooseOption({
        ...(input.provider ? { provided: input.provider } : {}),
        values: providers.map((candidate) => candidate.id),
        interactive,
        message: 'Choose a provider',
        labels: Object.fromEntries(
            providers.map((candidate) => [candidate.id, candidate.label])
        ),
        flag: '--provider',
        searchable: true,
    });
    const methods = connectionAuthenticationMethods(
        runtime,
        harness,
        provider,
        catalog
    );
    const methodId = await chooseOption({
        ...(input.method ? { provided: input.method } : {}),
        values: methods.map((method) => method.id),
        interactive,
        message: 'Choose an authentication method',
        labels: Object.fromEntries(methods.map((method) => [method.id, method.label])),
        flag: '--method',
    });
    const method = methods.find((candidate) => candidate.id === methodId);
    if (!method) throw new Error('An authentication method must be selected');
    return { runtime, harness, provider, method };
}

async function chooseOption<T extends string>(options: {
    provided?: string;
    values: T[];
    interactive: boolean;
    message: string;
    labels: Record<string, string>;
    hints?: Partial<Record<T, string>>;
    flag: string;
    searchable?: boolean;
}): Promise<T> {
    if (options.provided) {
        const normalized = options.provided.trim().toLowerCase();
        const value = options.values.find((candidate) => candidate === normalized);
        if (!value) {
            throw new Error(
                `Invalid ${options.flag} value ${options.provided}. Expected one of: ${options.values.join(', ')}`
            );
        }
        return value;
    }
    const only = options.values[0];
    if (options.values.length === 1 && only) return only;
    if (!options.interactive) {
        throw new Error(
            `wb connect requires ${options.flag} in a non-interactive terminal`
        );
    }
    const promptOptions: { message: string; options: Option<T>[] } = {
        message: options.message,
        options: options.values.map((value) => {
            const hint = options.hints?.[value];
            return {
                value,
                label: options.labels[value] ?? value,
                ...(hint ? { hint } : {}),
            } as Option<T>;
        }),
    };
    const selected = options.searchable
        ? await autocomplete<T>({
              ...promptOptions,
              placeholder: `Search ${options.message.slice('Choose a '.length)}`,
              maxItems: 7,
          })
        : await select<T>(promptOptions);
    if (typeof selected === 'symbol') throw new Error('Connection setup cancelled');
    return selected;
}

function connectionReference(target: ConnectionTarget): string {
    return `${target.runtime}/${target.harness}/${target.provider}`;
}
