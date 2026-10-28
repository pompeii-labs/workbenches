import { autocomplete, type Option, select } from '@clack/prompts';

import {
    type ConnectionAuthenticationMethod,
    connectionRuntimes,
} from '../connections/contracts.js';
import {
    type ConnectionTarget,
    connectionAuthenticationMethods,
    connectionHarnesses,
    connectionProviders,
    harnessLabel,
    runtimeLabel,
} from '../connections/targets.js';
import { ModelCatalog } from '../models/catalog.js';
import type { RunnerRegistry } from '../runners/registry.js';

/** A runtime, harness, and provider, with the method once one is chosen. */
export interface ConnectionChoice extends Omit<ConnectionTarget, 'method'> {
    methods: ConnectionAuthenticationMethod[];
    method?: ConnectionAuthenticationMethod;
}

/**
 * Chooses the target from flags or prompts, the questions `wb connect` asks
 * for this machine and for a worker alike. Without `chooseMethod`, a method
 * is chosen only when given.
 */
export async function selectConnectionTarget(
    input: {
        runtime?: string;
        harness?: string;
        provider?: string;
        method?: string;
        providers?: string[];
    },
    chooseMethod: boolean,
    runners: Pick<RunnerRegistry, 'find' | 'list'>
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
    const harnesses = connectionHarnesses(runners);
    const harness = await chooseOption({
        ...(input.harness ? { provided: input.harness } : {}),
        values: harnesses,
        interactive,
        message: 'Choose a harness',
        labels: Object.fromEntries(
            harnesses.map((value) => [value, harnessLabel(value, runners)])
        ),
        flag: '--harness',
    });
    const catalog = ModelCatalog.current();
    const providers = connectionProviders(harness, catalog, runners).filter(
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
        catalog,
        runners
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
