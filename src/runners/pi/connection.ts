import type { RunnerConnection } from '../runner.js';
import {
    PI_PACKAGE_VERSION,
    PI_PROVIDER_CAPABILITIES,
    piRouteCandidates,
} from './providers.js';

/**
 * Pi reads the catalog's capabilities for its verified package, or else its
 * built-in map. OpenAI splits into a ChatGPT subscription through
 * `openai-codex` and an API key, each offered only when Pi serves it. Pi has
 * no command-line login, so a subscription is signed in inside Pi itself.
 * Offline, `pi --list-models` lists only the models Pi holds a credential for.
 */
export const piConnection: RunnerConnection = {
    capabilities: (catalog) =>
        catalog.harnesses?.pi?.versions[PI_PACKAGE_VERSION]?.providers ??
        PI_PROVIDER_CAPABILITIES,
    candidates: (route, catalog) =>
        piRouteCandidates(route, piConnection.capabilities(catalog)),
    packagedProviders: false,
    probe: {
        command: ['pi', '--offline', '--list-models'],
        failsClosed: true,
        authenticated(listing, candidates) {
            const available = parsePiModels(listing);
            return candidates.filter((candidate) =>
                available.has(`${candidate.nativeProvider}/${candidate.nativeModel}`)
            );
        },
    },
    methods(_runtime, provider, catalog) {
        if (provider !== 'openai') return undefined;
        const capabilities = piConnection.capabilities(catalog)[provider];
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
    },
    manualSignIn: 'Run pi and sign in with /login',
    inRunSignIn: false,
};

/** The `provider/model` pairs in the listing's table, without its header. */
function parsePiModels(listing: string): Set<string> {
    const models = new Set<string>();
    for (const line of listing.split(/\r?\n/)) {
        const [provider, model] = line.trim().split(/\s+/);
        if (!provider || !model || provider === 'provider') continue;
        if (!/^[a-z0-9][a-z0-9._-]*$/i.test(provider)) continue;
        if (!/^[a-z0-9][a-z0-9._:/-]*$/i.test(model)) continue;
        models.add(`${provider}/${model}`);
    }
    return models;
}
