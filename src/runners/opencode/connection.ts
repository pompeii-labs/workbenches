import type { ModelCatalogHarnessProviderRoute } from '../../models/index.js';
import type { RunnerConnection } from '../runner.js';

/** The OpenCode release whose provider capabilities Workbench reads from the catalog. */
const OPENCODE_CATALOG_VERSION = '1.18.30';

/**
 * OpenCode reads the catalog's capabilities for its verified release, or else
 * signs in natively to every catalog provider. OpenAI offers a ChatGPT
 * subscription, through a browser on this host and headless elsewhere. A
 * route's provider is OpenCode's own, and `opencode auth list` shows which
 * providers hold a credential. `opencode auth login` signs in on the host, and
 * a first run can finish a sign-in inside the run.
 */
export const openCodeConnection: RunnerConnection = {
    capabilities: (catalog) =>
        catalog.harnesses?.opencode?.versions[OPENCODE_CATALOG_VERSION]?.providers ??
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
        ) as Record<string, ModelCatalogHarnessProviderRoute[]>),
    candidates: (route) => [
        {
            provider: route.provider,
            nativeProvider: route.provider,
            nativeModel: route.model,
        },
    ],
    packagedProviders: true,
    probe: {
        command: ['opencode', 'auth', 'list'],
        failsClosed: false,
        authenticated(listing, candidates) {
            const credentials = openCodeCredentials(listing);
            return candidates.flatMap((candidate) => {
                const method = credentials.get(normalizeProvider(candidate.provider));
                return method ? [{ ...candidate, authenticationMethod: method }] : [];
            });
        },
    },
    methods(runtime, provider) {
        if (provider !== 'openai') return undefined;
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
    },
    hostSignIn: {
        executable: 'opencode',
        arguments: (nativeProvider, nativeMethod) => [
            'auth',
            'login',
            '--provider',
            nativeProvider,
            ...(nativeMethod ? ['--method', nativeMethod] : []),
        ],
    },
    inRunSignIn: true,
};

/** Each `●` line of the listing names a provider, then its method last. */
function openCodeCredentials(listing: string): Map<string, string> {
    const credentials = new Map<string, string>();
    for (const line of listing
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.startsWith('●'))) {
        const parts = line.slice(1).trim().split(/\s+/);
        const method = parts.pop()?.toLowerCase();
        const provider = normalizeProvider(parts.join(' '));
        if (provider && method) credentials.set(provider, method);
    }
    return credentials;
}

function normalizeProvider(value: string): string {
    return value.toLowerCase().replaceAll(/[^a-z0-9]/g, '');
}
