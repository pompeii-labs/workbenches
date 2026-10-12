import { describe, expect, test } from 'bun:test';

import type { ConnectionAuthenticationMethod } from '../../src/connections/contracts.js';
import type { AuthenticatedModelRoute } from '../../src/models/index.js';
import type {
    ModelCatalogHarnessProviderRoute,
    ModelCatalogSnapshot,
} from '../../src/models/snapshot.js';
import { CLAUDE_CODE_PROVIDER_CAPABILITIES } from '../../src/runners/claude-code/connection.js';
import { PI_PROVIDER_CAPABILITIES } from '../../src/runners/pi/providers.js';
import { RunnerRegistry } from '../../src/runners/registry.js';
import type { Runner } from '../../src/runners/runner.js';
import { modelCatalogFixture } from '../model-catalog-fixture.js';

type Capabilities = Record<string, ModelCatalogHarnessProviderRoute[]>;

const routes = [
    { provider: 'openai', model: 'gpt-5.6-terra', value: 'openai/gpt-5.6-terra' },
    {
        provider: 'github-copilot',
        model: 'gpt-5.6-terra',
        value: 'github-copilot/gpt-5.6-terra',
    },
    {
        provider: 'openrouter',
        model: 'openai/gpt-5.6-terra',
        value: 'openrouter/openai/gpt-5.6-terra',
    },
    {
        provider: 'anthropic',
        model: 'claude-sonnet-4-5',
        value: 'anthropic/claude-sonnet-4-5',
    },
];

const nativeEverywhere: Capabilities = Object.fromEntries(
    Object.keys(modelCatalogFixture.providers).map((provider) => [
        provider,
        [{ native_provider: provider, auth: ['native'] }],
    ])
);

const piCatalogCapabilities =
    modelCatalogFixture.harnesses?.pi?.versions['0.84.3']?.providers;
if (!piCatalogCapabilities) throw new Error('missing Pi capability fixture');

const openAiApiKey: ConnectionAuthenticationMethod = {
    id: 'api-key',
    label: 'OpenAI API key',
    nativeProvider: 'openai',
    authenticationMethod: 'api',
};

/** What each registered runner declares, as the engine behaved before runners declared it. */
const expected: Record<
    string,
    {
        displayName: string;
        executable: string;
        runnerConfig: Runner['runnerConfig'];
        standardInput: boolean;
        /** Undefined for a runner whose credentials Workbench never keeps. */
        credentials:
            | {
                  file: string;
                  apiKeyEntryType: string;
                  storeFirst: boolean;
                  environment: Record<string, string>;
              }
            | undefined;
        capabilities: Capabilities;
        builtInCapabilities: Capabilities;
        catalogVersion: string;
        candidates: AuthenticatedModelRoute[];
        packagedProviders: boolean;
        probe: {
            command: string[];
            failsClosed: boolean;
            listing: string;
            authenticated: AuthenticatedModelRoute[];
        };
        methods: {
            local: ConnectionAuthenticationMethod[] | undefined;
            docker: ConnectionAuthenticationMethod[] | undefined;
        };
        hostSignIn?: { executable: string; plain: string[]; withMethod: string[] };
        manualSignIn?: string;
        inRunSignIn: boolean;
    }
> = {
    opencode: {
        displayName: 'OpenCode',
        executable: 'opencode',
        runnerConfig: 'either',
        standardInput: false,
        credentials: {
            file: 'opencode/auth.json',
            apiKeyEntryType: 'api',
            storeFirst: false,
            environment: { XDG_DATA_HOME: '/credentials' },
        },
        capabilities: nativeEverywhere,
        builtInCapabilities: nativeEverywhere,
        catalogVersion: '1.18.30',
        candidates: routes.map((route) => ({
            provider: route.provider,
            nativeProvider: route.provider,
            nativeModel: route.model,
        })),
        packagedProviders: true,
        probe: {
            command: ['opencode', 'auth', 'list'],
            failsClosed: false,
            listing: [
                '┌  Credentials ~/.local/share/opencode/auth.json',
                '│',
                '●  OpenAI oauth',
                '│',
                '●  GitHub Copilot oauth',
                '│',
                '●  OpenRouter api',
                '│',
                '└  3 credentials',
            ].join('\n'),
            authenticated: [
                {
                    provider: 'openai',
                    nativeProvider: 'openai',
                    nativeModel: 'gpt-5.6-terra',
                    authenticationMethod: 'oauth',
                },
                {
                    provider: 'github-copilot',
                    nativeProvider: 'github-copilot',
                    nativeModel: 'gpt-5.6-terra',
                    authenticationMethod: 'oauth',
                },
                {
                    provider: 'openrouter',
                    nativeProvider: 'openrouter',
                    nativeModel: 'openai/gpt-5.6-terra',
                    authenticationMethod: 'api',
                },
            ],
        },
        methods: {
            local: [
                {
                    id: 'chatgpt',
                    label: 'ChatGPT subscription',
                    nativeProvider: 'openai',
                    nativeMethod: 'ChatGPT Pro/Plus (browser)',
                    authenticationMethod: 'oauth',
                },
                { ...openAiApiKey, nativeMethod: 'Manually enter API Key' },
            ],
            docker: [
                {
                    id: 'chatgpt',
                    label: 'ChatGPT subscription (headless)',
                    nativeProvider: 'openai',
                    nativeMethod: 'ChatGPT Pro/Plus (headless)',
                    authenticationMethod: 'oauth',
                },
                { ...openAiApiKey, nativeMethod: 'Manually enter API Key' },
            ],
        },
        hostSignIn: {
            executable: 'opencode',
            plain: ['auth', 'login', '--provider', 'anthropic'],
            withMethod: [
                'auth',
                'login',
                '--provider',
                'openai',
                '--method',
                'ChatGPT Pro/Plus (browser)',
            ],
        },
        inRunSignIn: true,
    },
    pi: {
        displayName: 'Pi',
        executable: 'pi',
        runnerConfig: 'directory',
        standardInput: true,
        credentials: {
            file: 'auth.json',
            apiKeyEntryType: 'api_key',
            storeFirst: true,
            environment: { WORKBENCH_CREDENTIALS_DIR: '/credentials' },
        },
        capabilities: piCatalogCapabilities,
        builtInCapabilities: PI_PROVIDER_CAPABILITIES,
        catalogVersion: '0.84.3',
        candidates: [
            {
                provider: 'openai',
                nativeProvider: 'openai',
                nativeModel: 'gpt-5.6-terra',
                authenticationMethod: 'api',
            },
            {
                provider: 'openai',
                nativeProvider: 'openai-codex',
                nativeModel: 'gpt-5.6-terra',
                authenticationMethod: 'oauth',
            },
            {
                provider: 'github-copilot',
                nativeProvider: 'github-copilot',
                nativeModel: 'gpt-5.6-terra',
            },
            {
                provider: 'openrouter',
                nativeProvider: 'openrouter',
                nativeModel: 'openai/gpt-5.6-terra',
            },
            {
                provider: 'anthropic',
                nativeProvider: 'anthropic',
                nativeModel: 'claude-sonnet-4-5',
            },
        ],
        packagedProviders: false,
        probe: {
            command: ['pi', '--offline', '--list-models'],
            failsClosed: true,
            listing: [
                'provider      model                     context  max-out  thinking  images',
                'anthropic     claude-sonnet-4-5         200K     64K      yes       yes',
                'openai-codex  gpt-5.6-terra             272K     128K     yes       yes',
                'openrouter    openai/gpt-5.6-terra      400K     128K     yes       yes',
                '',
            ].join('\n'),
            authenticated: [
                {
                    provider: 'openai',
                    nativeProvider: 'openai-codex',
                    nativeModel: 'gpt-5.6-terra',
                    authenticationMethod: 'oauth',
                },
                {
                    provider: 'openrouter',
                    nativeProvider: 'openrouter',
                    nativeModel: 'openai/gpt-5.6-terra',
                },
                {
                    provider: 'anthropic',
                    nativeProvider: 'anthropic',
                    nativeModel: 'claude-sonnet-4-5',
                },
            ],
        },
        methods: {
            local: [
                {
                    id: 'chatgpt',
                    label: 'ChatGPT subscription',
                    nativeProvider: 'openai-codex',
                    authenticationMethod: 'oauth',
                },
                openAiApiKey,
            ],
            docker: [
                {
                    id: 'chatgpt',
                    label: 'ChatGPT subscription',
                    nativeProvider: 'openai-codex',
                    authenticationMethod: 'oauth',
                },
                openAiApiKey,
            ],
        },
        manualSignIn: 'Run pi and sign in with /login',
        inRunSignIn: false,
    },
    'claude-code': {
        displayName: 'Claude Code',
        executable: 'claude',
        runnerConfig: 'file',
        standardInput: true,
        credentials: undefined,
        capabilities: CLAUDE_CODE_PROVIDER_CAPABILITIES,
        builtInCapabilities: CLAUDE_CODE_PROVIDER_CAPABILITIES,
        catalogVersion: '2.1.292',
        candidates: [
            {
                provider: 'openrouter',
                nativeProvider: 'openrouter',
                nativeModel: 'openai/gpt-5.6-terra',
                authenticationMethod: 'api',
            },
            {
                provider: 'anthropic',
                nativeProvider: 'anthropic',
                nativeModel: 'claude-sonnet-4-5',
            },
        ],
        packagedProviders: false,
        probe: {
            command: ['/bin/sh', '-c', 'claude auth status --json || [ "$?" -eq 1 ]'],
            failsClosed: false,
            listing: JSON.stringify(
                {
                    loggedIn: true,
                    authMethod: 'claude.ai',
                    apiProvider: 'firstParty',
                    email: 'person@example.com',
                    subscriptionType: 'max',
                },
                null,
                2
            ),
            authenticated: [
                {
                    provider: 'anthropic',
                    nativeProvider: 'anthropic',
                    nativeModel: 'claude-sonnet-4-5',
                    authenticationMethod: 'oauth',
                },
            ],
        },
        methods: { local: undefined, docker: undefined },
        manualSignIn: 'Run claude auth login',
        inRunSignIn: false,
    },
};

describe('runner contract', () => {
    const runners = RunnerRegistry.standard().list();

    test('states the expected declarations of every registered runner', () => {
        expect(runners.map((runner) => runner.name)).toEqual(Object.keys(expected));
    });

    for (const runner of runners) {
        const declared = expected[runner.name];
        if (!declared) continue;

        describe(runner.name, () => {
            test('declares its name, executable, config shape, and standard input', () => {
                expect(runner.executable).toBe(declared.executable);
                expect(runner.runtimeContract().executable).toBe(declared.executable);
                expect(runner.displayName).toBe(declared.displayName);
                expect(runner.runnerConfig).toBe(declared.runnerConfig);
                expect(runner.standardInput).toBe(declared.standardInput);
                expect(runner.runtimeContract().standardInput).toBe(
                    declared.standardInput
                );
            });

            test('declares its native credential file', () => {
                if (!declared.credentials) {
                    expect(runner.credentials).toBeUndefined();
                    expect(
                        runner.runtimeContract().credentialEnvironment
                    ).toBeUndefined();
                    return;
                }
                const { environment, ...file } = declared.credentials;
                expect(runner.credentials).toMatchObject(file);
                expect(runner.credentials?.environment('/credentials')).toEqual(
                    environment
                );
                expect(
                    runner.runtimeContract().credentialEnvironment?.('/credentials')
                ).toEqual(environment);
            });

            test('reads provider capabilities from the catalog, else its own', () => {
                const connection = runner.connection;
                expect(connection.capabilities(modelCatalogFixture)).toEqual(
                    declared.capabilities
                );
                expect(
                    connection.capabilities({ ...modelCatalogFixture, harnesses: {} })
                ).toEqual(declared.builtInCapabilities);
                const published: Capabilities = {
                    fixture: [{ native_provider: 'native', auth: ['api'] }],
                };
                const versioned: ModelCatalogSnapshot = {
                    ...modelCatalogFixture,
                    harnesses: {
                        [runner.name]: {
                            versions: {
                                [declared.catalogVersion]: { providers: published },
                            },
                        },
                    },
                };
                expect(connection.capabilities(versioned)).toEqual(published);
            });

            test('maps manifest routes to native candidates', () => {
                expect(nativeCandidates(runner)).toEqual(declared.candidates);
            });

            test('reads its credential listing', () => {
                const connection = runner.connection;
                expect(connection.packagedProviders).toBe(declared.packagedProviders);
                expect(connection.probe.command).toEqual(declared.probe.command);
                expect(connection.probe.failsClosed).toBe(declared.probe.failsClosed);
                const candidates = nativeCandidates(runner);
                expect(
                    connection.probe.authenticated(declared.probe.listing, candidates)
                ).toEqual(declared.probe.authenticated);
                expect(connection.probe.authenticated('', candidates)).toEqual([]);
            });

            test('offers its own OpenAI methods and leaves other providers generic', () => {
                const connection = runner.connection;
                expect(
                    connection.methods('local', 'openai', modelCatalogFixture)
                ).toEqual(declared.methods.local);
                expect(
                    connection.methods('docker', 'openai', modelCatalogFixture)
                ).toEqual(declared.methods.docker);
                expect(
                    connection.methods('local', 'anthropic', modelCatalogFixture)
                ).toBeUndefined();
            });

            test('declares how a subscription is signed in', () => {
                const connection = runner.connection;
                expect(connection.inRunSignIn).toBe(declared.inRunSignIn);
                expect(connection.manualSignIn).toBe(declared.manualSignIn);
                expect(connection.hostSignIn?.executable).toBe(
                    declared.hostSignIn?.executable
                );
                expect(connection.hostSignIn?.arguments('anthropic')).toEqual(
                    declared.hostSignIn?.plain
                );
                expect(
                    connection.hostSignIn?.arguments(
                        'openai',
                        'ChatGPT Pro/Plus (browser)'
                    )
                ).toEqual(declared.hostSignIn?.withMethod);
            });
        });
    }
});

/** The native connections the runner offers for the fixture routes. */
function nativeCandidates(runner: Runner): AuthenticatedModelRoute[] {
    return routes.flatMap((route) =>
        runner.connection.candidates(route, modelCatalogFixture)
    );
}
