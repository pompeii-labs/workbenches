import type { ModelCatalogHarnessProviderRoute } from '../../models/index.js';
import type { RunnerConnection } from '../runner.js';
import { CLAUDE_CODE_VERSION } from './capabilities.js';

/** Anthropic by API key or subscription, and the gateways by their own key. */
export const CLAUDE_CODE_PROVIDER_CAPABILITIES: Record<
    string,
    ModelCatalogHarnessProviderRoute[]
> = {
    anthropic: [{ native_provider: 'anthropic', auth: ['api', 'oauth'] }],
    openrouter: [{ native_provider: 'openrouter', auth: ['api'] }],
    vercel: [{ native_provider: 'vercel', auth: ['api'] }],
};

/**
 * Claude Code reads the catalog's capabilities for its verified release, or
 * else its built-in map. Provider keys come from the environment and the
 * binary owns its login, so Workbench keeps no Claude Code credentials and
 * never extracts one: a subscription is signed in with `claude auth login`.
 * `claude auth status` reports that login, read only for its method.
 */
export const claudeCodeConnection: RunnerConnection = {
    capabilities: (catalog) =>
        catalog.harnesses?.['claude-code']?.versions[CLAUDE_CODE_VERSION]?.providers ??
        CLAUDE_CODE_PROVIDER_CAPABILITIES,
    candidates: (route, catalog) =>
        (claudeCodeConnection.capabilities(catalog)[route.provider] ?? []).map(
            (capability) => ({
                provider: route.provider,
                nativeProvider: capability.native_provider,
                nativeModel: route.model,
                ...(capability.auth.length === 1 && capability.auth[0]
                    ? { authenticationMethod: capability.auth[0] }
                    : {}),
            })
        ),
    packagedProviders: false,
    probe: {
        // Logged out, the command exits 1 after printing its status, which is an answer.
        command: ['/bin/sh', '-c', 'claude auth status --json || [ "$?" -eq 1 ]'],
        failsClosed: false,
        authenticated(listing, candidates) {
            const method = loginMethod(listing);
            if (!method) return [];
            return candidates.flatMap((candidate) =>
                candidate.nativeProvider === 'anthropic' &&
                (!candidate.authenticationMethod ||
                    candidate.authenticationMethod === method)
                    ? [{ ...candidate, authenticationMethod: method }]
                    : []
            );
        },
    },
    methods(runtime, provider) {
        // Outside the host, Workbench holds no Claude login, so Anthropic is a
        // key or a subscription token. Both come from the environment.
        if (provider !== 'anthropic' || runtime === 'local') return undefined;
        const key = {
            id: 'api-key',
            label: 'Anthropic API key (ANTHROPIC_API_KEY)',
            nativeProvider: 'anthropic',
            authenticationMethod: 'api' as const,
        };
        return [
            key,
            {
                id: 'setup-token',
                label: 'Claude subscription token (CLAUDE_CODE_OAUTH_TOKEN from claude setup-token)',
                nativeProvider: 'anthropic',
                authenticationMethod: 'oauth',
            },
        ];
    },
    manualSignIn: 'Run claude auth login',
    inRunSignIn: false,
};

/**
 * The method of the login `claude auth status --json` reports: a claude.ai
 * subscription or a `CLAUDE_CODE_OAUTH_TOKEN` is `oauth`, and `api_key`, which
 * covers a Console login (its `/login managed key`), is `api`. The verified
 * release prints only `none`, `third_party`, `claude.ai`, `api_key_helper`,
 * `oauth_token`, and `api_key`; any other value authenticates nothing. Only
 * `loggedIn`, `authMethod`, and `subscriptionType` are read.
 */
function loginMethod(listing: string): 'oauth' | 'api' | undefined {
    const status = statusObject(listing);
    if (status?.loggedIn !== true) return undefined;
    const subscription = status.subscriptionType;
    if (
        status.authMethod === 'claude.ai' &&
        typeof subscription === 'string' &&
        subscription
    ) {
        return 'oauth';
    }
    if (status.authMethod === 'oauth_token') return 'oauth';
    if (status.authMethod === 'api_key') return 'api';
    return undefined;
}

function statusObject(listing: string): Record<string, unknown> | undefined {
    const start = listing.indexOf('{');
    const end = listing.lastIndexOf('}');
    if (start < 0 || end < start) return undefined;
    try {
        const value: unknown = JSON.parse(listing.slice(start, end + 1));
        return typeof value === 'object' && value !== null && !Array.isArray(value)
            ? (value as Record<string, unknown>)
            : undefined;
    } catch {
        return undefined;
    }
}
