import type {
    ModelCatalogHarnessProviderRoute,
    ModelCatalogSnapshot,
} from '../models/catalog.js';
import {
    PI_PACKAGE_VERSION,
    PI_PROVIDER_CAPABILITIES,
} from '../runners/pi/providers.js';

export const connectionRuntimes = ['local', 'docker', 'e2b'] as const;
export type ConnectionRuntime = (typeof connectionRuntimes)[number];

export const connectionHarnesses = ['opencode', 'pi'] as const;
export type ConnectionHarness = (typeof connectionHarnesses)[number];

export interface ConnectionProvider {
    id: string;
    label: string;
}

export interface ConnectionAuthenticationMethod {
    id: string;
    label: string;
    nativeProvider: string;
    nativeMethod?: string;
    authenticationMethod: 'api' | 'oauth' | 'native';
}

export interface ConnectionTarget {
    runtime: ConnectionRuntime;
    harness: ConnectionHarness;
    provider: string;
    method: ConnectionAuthenticationMethod;
}

export function connectionProviders(
    harness: ConnectionHarness,
    catalog: ModelCatalogSnapshot
): ConnectionProvider[] {
    const capabilities = connectionProviderCapabilities(harness, catalog);
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
    harness: ConnectionHarness,
    provider: string,
    catalog: ModelCatalogSnapshot
): ConnectionAuthenticationMethod[] {
    if (harness === 'opencode' && provider === 'openai') {
        return [
            runtime === 'local'
                ? {
                      id: 'chatgpt',
                      label: 'ChatGPT subscription',
                      nativeProvider: 'openai',
                      nativeMethod: 'ChatGPT Pro/Plus (browser)',
                      authenticationMethod: 'oauth',
                  }
                : {
                      id: 'chatgpt',
                      label: 'ChatGPT subscription (headless)',
                      nativeProvider: 'openai',
                      nativeMethod: 'ChatGPT Pro/Plus (headless)',
                      authenticationMethod: 'oauth',
                  },
            {
                id: 'api-key',
                label: 'OpenAI API key',
                nativeProvider: 'openai',
                nativeMethod: 'Manually enter API Key',
                authenticationMethod: 'api',
            },
        ];
    }
    if (harness === 'pi' && provider === 'openai') {
        const capabilities = connectionProviderCapabilities(harness, catalog)[provider];
        return [
            ...(capabilities?.some(
                (candidate) =>
                    candidate.native_provider === 'openai-codex' &&
                    candidate.auth.includes('oauth')
            )
                ? [
                      {
                          id: 'chatgpt',
                          label: 'ChatGPT subscription',
                          nativeProvider: 'openai-codex',
                          authenticationMethod: 'oauth' as const,
                      },
                  ]
                : []),
            ...(capabilities?.some(
                (candidate) =>
                    candidate.native_provider === 'openai' &&
                    candidate.auth.includes('api')
            )
                ? [
                      {
                          id: 'api-key',
                          label: 'OpenAI API key',
                          nativeProvider: 'openai',
                          authenticationMethod: 'api' as const,
                      },
                  ]
                : []),
        ];
    }
    const [capability] =
        connectionProviderCapabilities(harness, catalog)[provider] ?? [];
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

export function connectionProviderCapabilities(
    harness: ConnectionHarness,
    catalog: ModelCatalogSnapshot
): Record<string, ModelCatalogHarnessProviderRoute[]> {
    if (harness === 'pi') {
        return (
            catalog.harnesses?.pi?.versions[PI_PACKAGE_VERSION]?.providers ??
            PI_PROVIDER_CAPABILITIES
        );
    }
    return (
        catalog.harnesses?.opencode?.versions['1.18.30']?.providers ??
        (Object.fromEntries(
            Object.keys(catalog.providers).map((provider) => [
                provider,
                [
                    {
                        native_provider: provider,
                        auth: ['native'],
                    },
                ],
            ])
        ) as Record<string, ModelCatalogHarnessProviderRoute[]>)
    );
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

export function harnessLabel(harness: string): string {
    if (harness === 'opencode') return 'OpenCode';
    if (harness === 'pi') return 'Pi';
    return harness;
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
