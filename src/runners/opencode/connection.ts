import type { ModelCatalogHarnessProviderRoute } from '../../models/index.js';
import type { RunnerConnection } from '../runner.js';
import { v2Method } from './authentication.js';

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
        versionCommand: ['--version'],
        arguments: (nativeProvider, nativeMethod, version) =>
            isOpenCodeV2(version ?? '2.0.0')
                ? [
                      'auth',
                      'login',
                      nativeProvider,
                      '--standalone',
                      ...(nativeMethod && nativeMethod !== 'Manually enter API Key'
                          ? ['--method', v2Method(nativeMethod)]
                          : []),
                  ]
                : [
                      'auth',
                      'login',
                      '--provider',
                      nativeProvider,
                      ...(nativeMethod ? ['--method', nativeMethod] : []),
                  ],
        async exportCredential(executable, environment, provider, version) {
            if (!isOpenCodeV2(version)) return undefined;
            const child = Bun.spawn(
                [executable, 'auth', 'export', provider, '--standalone'],
                {
                    env: environment,
                    stdout: 'pipe',
                    stderr: 'ignore',
                }
            );
            const output = await new Response(child.stdout).text();
            if ((await child.exited) !== 0)
                throw new Error('OpenCode could not export the private login');
            const credentials: unknown = JSON.parse(output);
            if (!Array.isArray(credentials))
                throw new Error('OpenCode returned an invalid credential export');
            const entry = credentials.find(
                (entry) => entry.integrationID === provider && entry.active
            );
            const value = entry?.value;
            if (!value) return undefined;
            if (value.type === 'key') return { type: 'api', key: value.key };
            if (value.type === 'oauth')
                return {
                    ...value,
                    ...(value.metadata?.accountID
                        ? { accountId: value.metadata.accountID }
                        : {}),
                };
            throw new Error('OpenCode returned an unsupported credential type');
        },
    },
    inRunSignIn: true,
};

export function isOpenCodeV2(version: string): boolean {
    return /^(?:opencode\s+)?v?2\./.test(version.trim());
}

/** Each `●` line of the listing names a provider, then its method last. */
function openCodeCredentials(listing: string): Map<string, string> {
    const credentials = new Map<string, string>();
    for (const line of listing
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)) {
        if (!line.startsWith('●')) {
            const match = line.match(
                /^(.+?)\s{2,}(OAuth|API key|External)\s{2,}(stored|environment)\s*$/i
            );
            if (match)
                credentials.set(
                    normalizeProvider(match[1] ?? ''),
                    match[2]?.toLowerCase() === 'oauth' ? 'oauth' : 'api'
                );
            continue;
        }
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
