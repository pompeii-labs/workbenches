import { autocomplete, type Option, select } from '@clack/prompts';
import { defineCommand } from 'citty';
import { ConnectionStore } from '../connections/store.js';
import {
    type ConnectionTarget,
    connectionAuthenticationMethods,
    connectionHarnesses,
    connectionProviders,
    connectionRuntimes,
    harnessLabel,
    providerLabel,
    runtimeLabel,
} from '../connections/targets.js';
import { ModelCatalog } from '../models/catalog.js';
import { ModelRouter } from '../models/routing.js';
import { workbenchHome } from '../storage.js';
import { WorkbenchResolver } from '../workbench/index.js';
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
    async run({ args }) {
        const output = new CliPresenter();
        const home = workbenchHome();
        let cleanup = async () => {};
        try {
            const selection = args.workbench
                ? await connectionTargetForWorkbench(args, home)
                : {
                      target: await selectConnectionTarget({
                          ...(args.runtime ? { runtime: args.runtime } : {}),
                          ...(args.harness ? { harness: args.harness } : {}),
                          ...(args.provider ? { provider: args.provider } : {}),
                          ...(args.method ? { method: args.method } : {}),
                      }),
                      cleanup,
                  };
            cleanup = selection.cleanup;
            const { target } = selection;
            await new ConnectionStore(home).save(
                { runner: target.harness, runtime: target.runtime },
                {
                    provider: target.provider,
                    nativeProvider: target.method.nativeProvider,
                    authenticationMethod: target.method.authenticationMethod,
                    method: target.method.id,
                    ...(target.method.nativeMethod
                        ? { nativeMethod: target.method.nativeMethod }
                        : {}),
                }
            );
            const runnerName = harnessLabel(target.harness);
            output.record({
                machine: [
                    'configured',
                    target.runtime,
                    target.harness,
                    target.provider,
                ],
                title: `Configured ${runnerName} in ${runtimeLabel(target.runtime)}`,
                details: [
                    providerLabel(target.provider),
                    target.method.label,
                    'Authentication will be requested by the first interactive run',
                ],
            });
        } finally {
            await cleanup();
        }
    },
});

async function connectionTargetForWorkbench(
    args: Record<string, unknown>,
    home: string
): Promise<{ target: ConnectionTarget; cleanup(): Promise<void> }> {
    const reference = String(args.workbench);
    const resolved = await new WorkbenchResolver().resolve(reference, {
        home,
        ...(typeof args.dir === 'string' ? { workspaceDirectory: args.dir } : {}),
    });
    try {
        const runtime = resolved.workbench.manifest.runtime;
        const harness = resolved.workbench.manifest.runner;
        if (!connectionRuntimes.includes(runtime as ConnectionTarget['runtime'])) {
            throw new Error(`Unsupported connection runtime: ${runtime}`);
        }
        if (!connectionHarnesses.includes(harness as ConnectionTarget['harness'])) {
            throw new Error(`Unsupported connection harness: ${harness}`);
        }
        const providers = [
            ...new Set(
                new ModelRouter()
                    .routes(resolved.workbench)
                    .map((route) => route.provider)
            ),
        ];
        const target = await selectConnectionTarget({
            runtime,
            harness,
            ...(typeof args.provider === 'string' ? { provider: args.provider } : {}),
            ...(typeof args.method === 'string' ? { method: args.method } : {}),
            providers,
        });
        return { target, cleanup: resolved.cleanup };
    } catch (error) {
        await resolved.cleanup();
        throw error;
    }
}

async function selectConnectionTarget(input: {
    runtime?: string;
    harness?: string;
    provider?: string;
    method?: string;
    providers?: string[];
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
    const providers = connectionProviders(harness, catalog).filter(
        (candidate) => !input.providers || input.providers.includes(candidate.id)
    );
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
