import { autocomplete, type Option, password, select } from '@clack/prompts';
import { defineCommand } from 'citty';
import type { ConnectionWorkbench } from '../connections/setup.js';
import {
    type ConnectionAuthenticationMethod,
    type ConnectionTarget,
    connectionAuthenticationMethods,
    connectionHarnesses,
    connectionProviders,
    connectionRuntimes,
    harnessLabel,
    runtimeLabel,
} from '../connections/targets.js';
import { ModelCatalog } from '../models/catalog.js';
import { ModelRouter } from '../models/routing.js';
import { type RuntimeKeyProvider, RuntimeSecretStore } from '../runtimes/secrets.js';
import { workbenchHome } from '../storage.js';
import { selectedRuntime, WorkbenchResolver, withRuntime } from '../workbench/index.js';
import { ModelConnection } from './connection.js';
import { CliPresenter } from './presenter.js';

export const connectCommand = defineCommand({
    meta: {
        name: 'connect',
        description: 'Connect model and runtime providers.',
    },
    args: {
        workbench: {
            type: 'positional',
            description: 'Saved alias or local Workbench reference',
            required: false,
        },
        dir: {
            type: 'string',
            description: 'Workspace directory (defaults to the current directory)',
        },
        runtime: {
            type: 'string',
            description:
                'Runtime: local, docker, e2b, or daytona (e2b and daytona alone connect their API key)',
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
        stdin: {
            type: 'boolean',
            description:
                'Read the key from standard input: a model key with --provider, or the E2B or Daytona runtime key',
            default: false,
        },
        yes: {
            type: 'boolean',
            description:
                "Copy your local runner's API key for the provider into the runtime without asking",
            default: false,
        },
        status: {
            type: 'boolean',
            description: 'Show runtime provider connection status',
            default: false,
        },
        remove: {
            type: 'boolean',
            description:
                "Remove a provider's model credential from a runtime, or a saved E2B or Daytona key",
            default: false,
        },
    },
    async run({ args }) {
        const output = new CliPresenter();
        const home = workbenchHome();
        const requested = args.runtime?.trim().toLowerCase();
        const runtimeKey =
            requested !== undefined &&
            Object.hasOwn(RuntimeSecretStore.providers, requested) &&
            !(
                args.workbench ||
                args.dir ||
                args.harness ||
                args.provider ||
                args.method
            );
        const modelTarget = Boolean(
            args.workbench ||
                args.dir ||
                (args.runtime && !runtimeKey) ||
                args.harness ||
                args.provider ||
                args.method
        );
        const runtimeProvider = runtimeKey
            ? requested
            : !modelTarget && process.stdin.isTTY && process.stderr.isTTY
              ? await chooseConnectionKind()
              : undefined;
        if (runtimeProvider) {
            await connectRuntimeProvider(runtimeProvider, args, home, output);
            return;
        }
        if (args.status) {
            throw new Error('--status requires --runtime e2b or --runtime daytona');
        }
        if (args.stdin && !args.provider) {
            throw new Error(
                '--stdin reads a model key with --runtime and --provider, or a runtime key with --runtime e2b or --runtime daytona alone'
            );
        }
        if (args.stdin && args.remove) {
            throw new Error('--stdin and --remove cannot be combined');
        }
        await new ModelCatalog({ home }).refresh();
        let cleanup = async () => {};
        try {
            const selection = args.workbench
                ? await connectionTargetForWorkbench(args, home, !args.remove)
                : {
                      choice: await selectConnectionTarget(
                          {
                              ...(args.runtime ? { runtime: args.runtime } : {}),
                              ...(args.harness ? { harness: args.harness } : {}),
                              ...(args.provider ? { provider: args.provider } : {}),
                              ...(args.method ? { method: args.method } : {}),
                          },
                          !args.remove
                      ),
                      cleanup,
                  };
            cleanup = selection.cleanup;
            const { choice } = selection;
            const workbench =
                'workbench' in selection ? selection.workbench : undefined;
            const connection = (method: ConnectionAuthenticationMethod) =>
                new ModelConnection({
                    home,
                    target: { ...choice, method },
                    output,
                    ...(workbench ? { workbench } : {}),
                });
            const method = choice.method ?? choice.methods[0];
            if (!method) throw new Error('An authentication method must be selected');
            if (args.remove) {
                await connection(method).remove(
                    choice.method ? [choice.method] : choice.methods
                );
                return;
            }
            await connection(method).connect({ stdin: args.stdin, yes: args.yes });
        } finally {
            await cleanup();
        }
    },
});

/** A runtime, harness, and provider, with the method once one is chosen. */
interface ConnectionChoice extends Omit<ConnectionTarget, 'method'> {
    methods: ConnectionAuthenticationMethod[];
    method?: ConnectionAuthenticationMethod;
}

async function chooseConnectionKind(): Promise<string | undefined> {
    const choice = await select({
        message: 'What would you like to connect?',
        options: [
            {
                value: 'model',
                label: 'Model provider',
                hint: 'OpenCode or Pi credentials and default route',
            },
            {
                value: 'e2b',
                label: 'E2B runtime',
                hint: 'Save a host-only sandbox API key once',
            },
            {
                value: 'daytona',
                label: 'Daytona runtime',
                hint: 'Save a host-only sandbox API key once',
            },
        ],
    });
    if (typeof choice === 'symbol') throw new Error('Connection setup cancelled');
    return choice === 'model' ? undefined : choice;
}

async function connectRuntimeProvider(
    provider: string,
    args: { stdin: boolean; status: boolean; remove: boolean },
    home: string,
    output: CliPresenter
): Promise<void> {
    const name = provider.trim().toLowerCase();
    if (!Object.hasOwn(RuntimeSecretStore.providers, name)) {
        throw new Error(`Unsupported runtime provider: ${provider}`);
    }
    const keyProvider = name as RuntimeKeyProvider;
    const { label, variable } = RuntimeSecretStore.providers[keyProvider];
    if (Number(args.stdin) + Number(args.status) + Number(args.remove) > 1) {
        throw new Error('--stdin, --status, and --remove cannot be combined');
    }
    const secrets = new RuntimeSecretStore(home);
    if (args.status) {
        const saved = Boolean(secrets.key(keyProvider));
        const override = Boolean(process.env[variable]?.trim());
        output.message(
            saved
                ? override
                    ? `${label} runtime key is saved; ${variable} currently overrides it`
                    : `${label} runtime key is saved`
                : override
                  ? `${label} runtime key is available from ${variable}`
                  : `No ${label} runtime key is saved`
        );
        return;
    }
    if (args.remove) {
        secrets.remove(keyProvider);
        output.message(`Removed the saved ${label} runtime key`, 'success');
        return;
    }
    let key: string;
    if (args.stdin) {
        key = await Bun.stdin.text();
    } else {
        if (!process.stdin.isTTY || !process.stderr.isTTY) {
            throw new Error(
                `Run wb connect --runtime ${name} in a terminal, or pass --stdin`
            );
        }
        const entered = await password({
            message: `${label} API key`,
            validate: (value) =>
                value?.trim() ? undefined : `Enter your ${label} API key`,
        });
        if (typeof entered === 'symbol') {
            throw new Error('Connection setup cancelled');
        }
        key = entered;
    }
    secrets.save(keyProvider, key);
    output.message(`${label} runtime key saved on this machine`, 'success');
}

async function connectionTargetForWorkbench(
    args: Record<string, unknown>,
    home: string,
    chooseMethod: boolean
): Promise<{
    choice: ConnectionChoice;
    workbench: ConnectionWorkbench;
    cleanup(): Promise<void>;
}> {
    const reference = String(args.workbench);
    const resolved = await new WorkbenchResolver().resolve(reference, {
        home,
        ...(typeof args.dir === 'string' ? { workspaceDirectory: args.dir } : {}),
    });
    try {
        const workbench = withRuntime(
            resolved.workbench,
            typeof args.runtime === 'string'
                ? args.runtime.trim().toLowerCase()
                : undefined
        );
        const runtime = selectedRuntime(workbench).name;
        const harness = workbench.manifest.runner;
        if (!connectionRuntimes.includes(runtime as ConnectionTarget['runtime'])) {
            throw new Error(`Unsupported connection runtime: ${runtime}`);
        }
        if (!connectionHarnesses.includes(harness as ConnectionTarget['harness'])) {
            throw new Error(`Unsupported connection harness: ${harness}`);
        }
        const providers = [
            ...new Set(
                new ModelRouter(ModelCatalog.current())
                    .routes(workbench)
                    .map((route) => route.provider)
            ),
        ];
        const choice = await selectConnectionTarget(
            {
                runtime,
                harness,
                ...(typeof args.provider === 'string'
                    ? { provider: args.provider }
                    : {}),
                ...(typeof args.method === 'string' ? { method: args.method } : {}),
                providers,
            },
            chooseMethod
        );
        return {
            choice,
            workbench: {
                workbench,
                reference,
                workspaceDirectory: resolved.workspaceDirectory,
            },
            cleanup: resolved.cleanup,
        };
    } catch (error) {
        await resolved.cleanup();
        throw error;
    }
}

/** Chooses the target from flags or prompts. Without `chooseMethod`, a method is chosen only when given. */
async function selectConnectionTarget(
    input: {
        runtime?: string;
        harness?: string;
        provider?: string;
        method?: string;
        providers?: string[];
    },
    chooseMethod: boolean
): Promise<ConnectionChoice> {
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
            daytona: 'cloud sandbox',
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
    if (!chooseMethod && !input.method) return { runtime, harness, provider, methods };
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
    return { runtime, harness, provider, methods, method };
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
