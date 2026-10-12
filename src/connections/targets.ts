import type { ModelCatalogSnapshot } from '../models/snapshot.js';
import { RunnerRegistry } from '../runners/registry.js';
import type { RunnerConnection } from '../runners/runner.js';
import type { ConnectionAuthenticationMethod, ConnectionRuntime } from './contracts.js';

/** Every registered runner, in registration order. */
export function connectionHarnesses(runners: Pick<RunnerRegistry, 'list'>): string[] {
    return runners.list().map((runner) => runner.name);
}

export interface ConnectionProvider {
    id: string;
    label: string;
}

export interface ConnectionTarget {
    runtime: ConnectionRuntime;
    harness: string;
    provider: string;
    method: ConnectionAuthenticationMethod;
}

export function connectionProviders(
    harness: string,
    catalog: ModelCatalogSnapshot,
    runners: Pick<RunnerRegistry, 'find'> = RunnerRegistry.standard()
): ConnectionProvider[] {
    const capabilities = harnessConnection(harness, runners).capabilities(catalog);
    const served = new Set(
        Object.values(catalog.models).flatMap((model) => Object.keys(model.routes))
    );
    return [...served]
        .filter(
            (provider) => catalog.providers[provider] && capabilities[provider]?.length
        )
        .map((provider) => ({ id: provider, label: providerLabel(provider) }))
        .toSorted((left, right) => {
            const difference = providerRank(left.id) - providerRank(right.id);
            return difference || left.label.localeCompare(right.label);
        });
}

export function connectionAuthenticationMethods(
    runtime: ConnectionRuntime,
    harness: string,
    provider: string,
    catalog: ModelCatalogSnapshot,
    runners: Pick<RunnerRegistry, 'find'> = RunnerRegistry.standard()
): ConnectionAuthenticationMethod[] {
    const connection = harnessConnection(harness, runners);
    const methods = connection.methods(runtime, provider, catalog);
    if (methods) return methods;
    const [capability] = connection.capabilities(catalog)[provider] ?? [];
    if (!capability) return [];
    if (capability.auth.length === 1 && capability.auth[0] === 'api') {
        return [
            {
                id: 'api-key',
                label: `${providerLabel(provider)} credentials`,
                nativeProvider: capability.native_provider,
                authenticationMethod: 'api',
            },
        ];
    }
    return [
        {
            id: 'native',
            label: `${providerLabel(provider)} sign-in`,
            nativeProvider: capability.native_provider,
            authenticationMethod: 'native',
        },
    ];
}

/** The connection support a harness declares. */
export function harnessConnection(
    harness: string,
    runners: Pick<RunnerRegistry, 'find'>
): RunnerConnection {
    const runner = runners.find(harness);
    if (!runner) throw new Error(`Unsupported connection harness: ${harness}`);
    return runner.connection;
}

export function connectionModel(
    provider: string,
    catalog: ModelCatalogSnapshot
): { canonical: string; native: string } {
    const candidates = Object.entries(catalog.models)
        .flatMap(([canonical, model]) => {
            const native = model.routes[provider];
            return native ? [{ canonical, native }] : [];
        })
        .toSorted((left, right) => {
            const leftRank = left.canonical.startsWith(`${provider}/`) ? 0 : 1;
            const rightRank = right.canonical.startsWith(`${provider}/`) ? 0 : 1;
            return (
                leftRank - rightRank || left.canonical.localeCompare(right.canonical)
            );
        });
    const selected = candidates[0];
    if (!selected) throw new Error(`No model is available through ${provider}`);
    return selected;
}

export function runtimeLabel(runtime: string): string {
    if (runtime === 'e2b') return 'E2B';
    return runtime.charAt(0).toUpperCase() + runtime.slice(1);
}

export function harnessLabel(
    harness: string,
    runners: Pick<RunnerRegistry, 'find'>
): string {
    return runners.find(harness)?.displayName ?? harness;
}

export function providerLabel(provider: string): string {
    const known = {
        anthropic: 'Anthropic',
        'github-copilot': 'GitHub Copilot',
        opencode: 'OpenCode',
        openai: 'OpenAI',
        openrouter: 'OpenRouter',
    }[provider];
    if (known) return known;
    return provider
        .split('-')
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(' ');
}

function providerRank(provider: string): number {
    if (provider === 'openai') return 0;
    if (provider === 'anthropic') return 1;
    if (provider === 'openrouter') return 2;
    return 3;
}
