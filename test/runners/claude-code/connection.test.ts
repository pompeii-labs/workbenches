import { afterAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type {
    AuthenticatedModelRoute,
    ModelCatalogSnapshot,
} from '../../../src/models/index.js';
import { launchEnvironment } from '../../../src/platform/environment.js';
import { join } from '../../../src/platform/paths.js';
import { hostCommand } from '../../../src/platform/process.js';
import {
    CLAUDE_CODE_PROVIDER_CAPABILITIES,
    claudeCodeConnection,
} from '../../../src/runners/claude-code/connection.js';
import { claudeCodeRoute } from '../../../src/runners/claude-code/routes.js';
import { modelCatalogFixture } from '../../model-catalog-fixture.js';
import { executableScript } from '../../platform.js';

const catalog: ModelCatalogSnapshot = {
    ...modelCatalogFixture,
    models: {
        ...modelCatalogFixture.models,
        'anthropic/claude-sonnet-4-5': {
            routes: {
                anthropic: 'claude-sonnet-4-5',
                openrouter: 'anthropic/claude-sonnet-4.5',
                vercel: 'anthropic/claude-sonnet-4.5',
                bedrock: 'anthropic.claude-sonnet-4-5',
            },
        },
    },
    providers: {
        ...modelCatalogFixture.providers,
        vercel: { env: ['AI_GATEWAY_API_KEY'] },
        bedrock: { env: ['AWS_ACCESS_KEY_ID'] },
    },
};

const anthropic: AuthenticatedModelRoute = {
    provider: 'anthropic',
    nativeProvider: 'anthropic',
    nativeModel: 'claude-sonnet-4-5',
};

const candidates = (['anthropic', 'openrouter', 'vercel', 'bedrock'] as const).flatMap(
    (provider) =>
        claudeCodeConnection.candidates(
            {
                provider,
                model:
                    catalog.models['anthropic/claude-sonnet-4-5']?.routes[provider] ??
                    '',
                value: provider,
            },
            catalog
        )
);

describe('Claude Code connection', () => {
    test('reaches Anthropic by key or subscription and the gateways by key', () => {
        expect(claudeCodeConnection.capabilities(catalog)).toEqual({
            anthropic: [{ native_provider: 'anthropic', auth: ['api', 'oauth'] }],
            openrouter: [{ native_provider: 'openrouter', auth: ['api'] }],
            vercel: [{ native_provider: 'vercel', auth: ['api'] }],
        });
        expect(CLAUDE_CODE_PROVIDER_CAPABILITIES).toEqual(
            claudeCodeConnection.capabilities(catalog)
        );
    });

    test('offers each catalog route of its providers with the provider-native model', () => {
        expect(candidates).toEqual([
            anthropic,
            {
                provider: 'openrouter',
                nativeProvider: 'openrouter',
                nativeModel: 'anthropic/claude-sonnet-4.5',
                authenticationMethod: 'api',
            },
            {
                provider: 'vercel',
                nativeProvider: 'vercel',
                nativeModel: 'anthropic/claude-sonnet-4.5',
                authenticationMethod: 'api',
            },
        ]);
    });

    const status = (fields: Record<string, unknown>) =>
        JSON.stringify({
            apiProvider: 'firstParty',
            email: 'person@example.com',
            ...fields,
        });

    test.each([
        [{ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'pro' }, 'oauth'],
        [{ loggedIn: true, authMethod: 'oauth_token' }, 'oauth'],
        [
            {
                loggedIn: true,
                authMethod: 'api_key',
                apiKeySource: '/login managed key',
            },
            'api',
        ],
    ])('authenticates the Anthropic route of %j as %s', (fields, method) => {
        expect(
            claudeCodeConnection.probe.authenticated(status(fields), candidates)
        ).toEqual([{ ...anthropic, authenticationMethod: method }]);
    });

    test.each([
        [{ loggedIn: false, authMethod: 'none' }],
        [{ loggedIn: true, authMethod: 'claude.ai', subscriptionType: null }],
        [{ loggedIn: true, authMethod: 'third_party' }],
        [{ loggedIn: true, authMethod: 'api_key_helper' }],
        [{ loggedIn: 'true', authMethod: 'claude.ai', subscriptionType: 'max' }],
    ])('authenticates nothing for %j', (fields) => {
        expect(
            claudeCodeConnection.probe.authenticated(status(fields), candidates)
        ).toEqual([]);
    });

    test('reads the status object out of surrounding output and ignores garbage', () => {
        const listing = `warning: update available\n${status({
            loggedIn: true,
            authMethod: 'claude.ai',
            subscriptionType: 'max',
        })}\n`;
        expect(claudeCodeConnection.probe.authenticated(listing, candidates)).toEqual([
            { ...anthropic, authenticationMethod: 'oauth' },
        ]);
        expect(
            claudeCodeConnection.probe.authenticated('{not json}', candidates)
        ).toEqual([]);
        // A login never authenticates a gateway, which needs its own key.
        expect(
            claudeCodeConnection.probe.authenticated(
                status({ loggedIn: true, authMethod: 'api_key' }),
                candidates.filter((candidate) => candidate.provider !== 'anthropic')
            )
        ).toEqual([]);
    });

    test('offers Anthropic as a key outside the host, or a token, and leaves the rest generic', () => {
        expect(
            claudeCodeConnection.methods('local', 'anthropic', catalog)
        ).toBeUndefined();
        const key = {
            id: 'api-key',
            label: 'Anthropic API key (ANTHROPIC_API_KEY)',
            nativeProvider: 'anthropic',
            authenticationMethod: 'api' as const,
        };
        for (const runtime of ['docker', 'e2b', 'daytona'] as const) {
            expect(claudeCodeConnection.methods(runtime, 'anthropic', catalog)).toEqual(
                [
                    key,
                    {
                        id: 'setup-token',
                        label: 'Claude subscription token (CLAUDE_CODE_OAUTH_TOKEN from claude setup-token)',
                        nativeProvider: 'anthropic',
                        authenticationMethod: 'oauth',
                    },
                ]
            );
            expect(
                claudeCodeConnection.methods(runtime, 'openrouter', catalog)
            ).toBeUndefined();
        }
        expect(claudeCodeConnection.manualSignIn).toBe('Run claude auth login');
        expect(claudeCodeConnection.hostSignIn).toBeUndefined();
        expect(claudeCodeConnection.inRunSignIn).toBe(false);
        expect(claudeCodeConnection.probe.failsClosed).toBe(false);
        expect(claudeCodeConnection.packagedProviders).toBe(false);
    });

    describe('probe command', () => {
        const root = mkdtemp(join(tmpdir(), 'b3-probe-'));
        afterAll(async () => rm(await root, { recursive: true, force: true }));

        async function probe(code: number): Promise<number> {
            const bin = join(await root, String(code));
            await mkdir(bin);
            await writeFile(
                join(bin, 'claude'),
                `#!/usr/bin/env bun\nconsole.log(JSON.stringify({loggedIn:false}));process.exit(${code});\n`,
                { mode: 0o755 }
            );
            await executableScript(join(bin, 'claude'));
            const [command, ...args] =
                claudeCodeConnection.probe.commandFor?.(await root) ??
                claudeCodeConnection.probe.command;
            const child = Bun.spawn(
                hostCommand([command as string, ...args], { PATH: bin }),
                {
                    env: launchEnvironment({ PATH: bin }),
                    stdout: 'ignore',
                }
            );
            return child.exited;
        }

        test('treats a logged-out status as an answer and other failures as failures', async () => {
            expect(await probe(0)).toBe(0);
            expect(await probe(1)).toBe(0);
            expect(await probe(2)).not.toBe(0);
        });
    });
});

describe('Claude Code routes', () => {
    const base = {
        environment: {},
        keys: ['ANTHROPIC_API_KEY'],
        configDirectory: '/session/claude-code',
    };

    test('an Anthropic key is a metered route that never reads a login', () => {
        for (const runtime of ['local', 'docker', 'e2b', 'daytona']) {
            expect(
                claudeCodeRoute({
                    ...base,
                    provider: 'anthropic',
                    runtime,
                    environment: { ANTHROPIC_API_KEY: ' anthropic-key ' },
                    oauthToken: 'oauth-token',
                })
            ).toEqual({
                environment: { ANTHROPIC_API_KEY: 'anthropic-key' },
                billing: 'metered',
                secureStorageDirectory: '/session/claude-code',
            });
        }
    });

    test('a subscription reads the person login only on local, and a token on local and Docker', () => {
        expect(
            claudeCodeRoute({
                ...base,
                provider: 'anthropic',
                runtime: 'local',
                authenticationMethod: 'oauth',
            })
        ).toEqual({
            environment: {},
            billing: 'subscription',
            secureStorageDirectory: '',
        });
        expect(
            claudeCodeRoute({
                ...base,
                provider: 'anthropic',
                runtime: 'docker',
                oauthToken: 'oauth-token',
            })
        ).toEqual({
            environment: { CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token' },
            billing: 'subscription',
            secureStorageDirectory: '/session/claude-code',
        });
    });

    test('a local Console login, or one never reported, is metered', () => {
        for (const authenticationMethod of ['api', undefined]) {
            expect(
                claudeCodeRoute({
                    ...base,
                    provider: 'anthropic',
                    runtime: 'local',
                    ...(authenticationMethod ? { authenticationMethod } : {}),
                })
            ).toEqual({
                environment: {},
                billing: 'metered',
                secureStorageDirectory: '',
            });
        }
        // A host token is a subscription whatever the login is.
        expect(
            claudeCodeRoute({
                ...base,
                provider: 'anthropic',
                runtime: 'local',
                authenticationMethod: 'api',
                oauthToken: 'oauth-token',
            }).billing
        ).toBe('subscription');
    });

    test('a remote runtime takes the environment token as a subscription, never a login', () => {
        for (const runtime of ['e2b', 'daytona', 'unknown']) {
            expect(
                claudeCodeRoute({
                    ...base,
                    provider: 'anthropic',
                    runtime,
                    oauthToken: 'oauth-token',
                })
            ).toEqual({
                environment: { CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token' },
                billing: 'subscription',
                secureStorageDirectory: '/session/claude-code',
            });
            expect(() =>
                claudeCodeRoute({
                    ...base,
                    provider: 'anthropic',
                    runtime,
                    authenticationMethod: 'oauth',
                })
            ).toThrow(
                `Claude Code on the ${runtime} runtime needs ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN`
            );
        }
    });

    test.each([
        ['openrouter', 'OPENROUTER_API_KEY', 'https://openrouter.ai/api'],
        ['vercel', 'AI_GATEWAY_API_KEY', 'https://ai-gateway.vercel.sh/claude-code'],
    ])('%s is a gateway behind the Anthropic base URL', (provider, key, url) => {
        for (const runtime of ['local', 'e2b']) {
            expect(
                claudeCodeRoute({
                    ...base,
                    provider,
                    runtime,
                    keys: [key],
                    environment: { [key]: 'gateway-key', ANTHROPIC_API_KEY: 'unused' },
                    oauthToken: 'oauth-token',
                })
            ).toEqual({
                environment: {
                    ANTHROPIC_BASE_URL: url,
                    ANTHROPIC_AUTH_TOKEN: 'gateway-key',
                    ANTHROPIC_API_KEY: '',
                },
                billing: 'metered',
                secureStorageDirectory: '/session/claude-code',
            });
        }
        expect(() =>
            claudeCodeRoute({ ...base, provider, runtime: 'local', keys: [key] })
        ).toThrow(`Claude Code needs ${key} for the ${provider} route`);
    });

    test('refuses a provider it cannot reach', () => {
        expect(() =>
            claudeCodeRoute({ ...base, provider: 'bedrock', runtime: 'local' })
        ).toThrow('Claude Code cannot reach model provider bedrock');
    });
});
