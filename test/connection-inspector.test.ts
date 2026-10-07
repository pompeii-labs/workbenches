import { describe, expect, test } from 'bun:test';

import {
    ConnectionInspector,
    type ConnectionInspectorOptions,
} from '../src/connections/inspector.js';
import type { PreparedRunner } from '../src/runners/runner.js';
import type { PreparedRuntime } from '../src/runtimes/contracts.js';
import type { ResolvedWorkbench } from '../src/types.js';
import { activateModelCatalogFixture } from './model-catalog-fixture.js';

activateModelCatalogFixture();

describe('native runner authentication', () => {
    test('offers only locked model routes and Pi subscription equivalents', () => {
        const openCode = fixture('opencode');
        openCode.manifest.model = {
            id: 'openai/gpt-5.6-terra',
            routes: [{ provider: 'openai' }, { provider: 'openrouter' }],
        };
        expect(inspector(openCode).candidates()).toEqual([
            {
                provider: 'openai',
                nativeProvider: 'openai',
                nativeModel: 'gpt-5.6-terra',
            },
            {
                provider: 'openrouter',
                nativeProvider: 'openrouter',
                nativeModel: 'openai/gpt-5.6-terra',
            },
        ]);

        expect(inspector(fixture('pi')).candidates()).toEqual([
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
        ]);
    });

    test('maps a Pi Codex subscription to the locked OpenAI model route', async () => {
        const workbench = fixture('pi');
        const status = await inspector(workbench, {
            runner: runner('pi'),
            runtime: runtime(
                'provider  model  context\nopenai-codex  gpt-5.6-terra  1M\n'
            ),
        }).inspect();

        expect(status).toMatchObject({
            ready: true,
            configuration: {
                provider: 'openai',
                nativeProvider: 'openai-codex',
                nativeModel: 'gpt-5.6-terra',
                model: 'openai-codex/gpt-5.6-terra',
            },
        });
    });

    test('does not confuse OpenRouter with OpenAI in OpenCode output', async () => {
        const workbench = fixture('opencode');
        const status = await inspector(workbench, {
            runner: runner('opencode'),
            runtime: runtime(
                '┌ Credentials ~/.local/share/opencode/auth.json\n│\n● OpenRouter api\n│\n└ 1 credential\n'
            ),
        }).inspect();

        expect(status.ready).toBeFalse();
        expect(status.authenticatedProviders).toEqual([]);
    });

    test('reads only OpenCode credential rows, not its credential path', async () => {
        const workbench = fixture('opencode');
        workbench.manifest.model = {
            id: 'openai/gpt-5.6-terra',
            routes: [{ provider: 'openai' }, { provider: 'opencode' }],
        };
        const status = await inspector(workbench, {
            runner: runner('opencode'),
            runtime: runtime(
                '┌ Credentials ~/.local/share/opencode/auth.json\n│\n● OpenAI oauth\n│\n└ 1 credential\n'
            ),
        }).inspect();

        expect(status.authenticatedProviders).toEqual(['openai']);
        expect(status.connections[0]?.authenticationMethod).toBe('oauth');
    });

    test('uses an explicitly bound environment route without scanning native credentials', async () => {
        const workbench = fixture('opencode');
        workbench.manifest.model = {
            id: 'openai/gpt-5.6-terra',
            routes: [{ provider: 'openai' }, { provider: 'openrouter' }],
        };
        let inspected = false;
        const prepared = runtime('● OpenAI oauth\n', {
            environment: { OPENROUTER_API_KEY: 'configured' },
            execute() {
                inspected = true;
                return Promise.reject(new Error('must not inspect'));
            },
        });

        const status = await inspector(workbench, {
            runner: runner('opencode'),
            runtime: prepared,
        }).inspect();

        expect(status.authenticatedProviders).toEqual(['openrouter']);
        expect(status.configuration?.provider).toBe('openrouter');
        expect(inspected).toBeFalse();

        const discovered = await inspector(workbench, {
            runner: runner('opencode'),
            runtime: prepared,
        }).inspect({ discoverConnections: true });
        expect(discovered.configuration?.provider).toBe('openrouter');
        expect(inspected).toBeTrue();
    });

    test('uses an explicit authenticated connection without changing the locked model', async () => {
        const workbench = fixture('opencode');
        workbench.manifest.model = {
            id: 'openai/gpt-5.6-terra',
            routes: [{ provider: 'openai' }, { provider: 'openrouter' }],
        };
        const connection = inspector(workbench, {
            runner: runner('opencode'),
            runtime: runtime('● OpenAI oauth\n● OpenRouter api\n'),
        });

        await expect(connection.require('openrouter')).resolves.toMatchObject({
            canonicalModel: 'openai/gpt-5.6-terra',
            provider: 'openrouter',
            nativeProvider: 'openrouter',
        });
        await expect(connection.require('anthropic')).rejects.toThrow(
            'Connection anthropic is not authenticated for openai/gpt-5.6-terra'
        );
    });

    test('accepts an unknown config-backed provider without inventing credentials', async () => {
        const workbench = fixture('opencode');
        workbench.manifest.model = {
            id: 'private/model',
            routes: [{ provider: 'local-gateway', model: 'deployment-42' }],
        };
        workbench.runnerConfigPath = '/package/runner';

        const status = await inspector(workbench, {
            runner: runner('opencode'),
            runtime: runtime(''),
        }).inspect();

        expect(status).toMatchObject({
            ready: true,
            authenticatedProviders: ['local-gateway'],
            configuration: {
                provider: 'local-gateway',
                model: 'local-gateway/deployment-42',
            },
        });
    });

    test('requires an authenticated route with one actionable connect command', async () => {
        const workbench = fixture('pi');
        await expect(
            inspector(workbench, {
                runner: runner('pi'),
                runtime: runtime('provider model\n'),
                reference: 'publisher/project#core',
            }).require()
        ).rejects.toThrow(
            'No authenticated route is available for openai/gpt-5.6-terra. Run wb connect publisher/project#core --runtime local, or pass the provider key for one run with --env-file.'
        );
    });

    test('reports Claude Code API and native OAuth authentication', async () => {
        const workbench = fixture('claude-code');
        workbench.manifest.model = { id: 'anthropic/claude-sonnet-4-5' };
        let inspected = false;
        const api = await inspector(workbench, {
            runner: runner('claude-code'),
            runtime: runtime('', {
                workbench,
                environment: { ANTHROPIC_API_KEY: 'configured' },
                execute: async () => {
                    inspected = true;
                    return { code: 1, stdout: '', stderr: '' };
                },
            }),
        }).inspect();
        expect(api).toMatchObject({
            ready: true,
            authenticatedProviders: ['anthropic'],
            connections: [{ authenticationMethod: 'api' }],
        });
        expect(inspected).toBeFalse();

        const oauth = await inspector(workbench, {
            runner: runner('claude-code'),
            runtime: runtime('{"loggedIn":true}', {
                workbench,
            }),
        }).inspect();
        expect(oauth.connections[0]?.authenticationMethod).toBe('oauth');

        const remoteOauth = await inspector(workbench, {
            runner: runner('claude-code'),
            runtime: runtime('', {
                name: 'e2b',
                workbench,
                environment: {},
            }),
        }).inspect();
        expect(remoteOauth.ready).toBeFalse();
        expect(remoteOauth.connections).toEqual([]);

        const both = await inspector(workbench, {
            runner: runner('claude-code'),
            runtime: runtime('', {
                workbench,
                environment: {
                    ANTHROPIC_API_KEY: 'configured',
                },
            }),
        }).inspect();
        expect(both.connections[0]?.authenticationMethod).toBe('api');
    });

    test('fails closed when Claude auth status is not ready', async () => {
        const workbench = fixture('claude-code');
        workbench.manifest.model = { id: 'anthropic/claude-sonnet-4-5' };
        let inspected = false;
        const status = await inspector(workbench, {
            runner: runner('claude-code'),
            runtime: runtime('', {
                workbench,
                environment: { CLAUDE_SECURESTORAGE_CONFIG_DIR: '' },
                execute: async () => {
                    inspected = true;
                    return { code: 1, stdout: '', stderr: '' };
                },
            }),
        }).inspect();

        expect(inspected).toBeTrue();
        expect(status.ready).toBeFalse();
        expect(status.authenticatedProviders).toEqual([]);
        expect(status.instruction).toBeUndefined();
        expect(status.connectCommand).toBe('wb connect fixture --runtime local');
    });

    test('resolves Claude Code routes like OpenCode', () => {
        const openCode = fixture('opencode');
        const claudeCode = fixture('claude-code');
        openCode.manifest.model = { id: 'anthropic/claude-sonnet-4-5' };
        claudeCode.manifest.model = { id: 'anthropic/claude-sonnet-4-5' };
        expect(inspector(claudeCode).candidates()).toEqual(
            inspector(openCode).candidates()
        );
    });

    test('names a non-local runtime in the connect command so it fills that store', async () => {
        const workbench = fixture('opencode');
        const status = await inspector(workbench, {
            runner: runner('opencode'),
            runtime: runtime('┌ Credentials\n└ 0 credentials\n', { name: 'docker' }),
            reference: './project#core',
        }).inspect();

        expect(status.ready).toBeFalse();
        expect(status.connectCommand).toBe(
            'wb connect ./project#core --runtime docker'
        );
        await expect(
            inspector(workbench, {
                runner: runner('opencode'),
                runtime: runtime('', { name: 'e2b' }),
                reference: 'fixture',
            }).require()
        ).rejects.toThrow(
            'Run wb connect fixture --runtime e2b, or pass the provider key'
        );
    });
});

function inspector(
    workbench: ResolvedWorkbench,
    options: Omit<ConnectionInspectorOptions, 'workbench'> = {
        runner: runner(workbench.manifest.runner),
        runtime: runtime(''),
    }
): ConnectionInspector {
    return new ConnectionInspector({ workbench, ...options });
}

function fixture(runnerName: 'opencode' | 'pi' | 'claude-code'): ResolvedWorkbench {
    return {
        manifestPath: '/repo/.workbenches/core/workbench.yml',
        packageDirectory: '/repo/.workbenches/core',
        repositoryDirectory: '/repo',
        instructionsPath: '/repo/.workbenches/core/instructions.md',
        skills: [],
        manifest: {
            spec: 0,
            version: '0.1.0',
            name: 'fixture',
            runner: runnerName,
            model: {
                id: 'openai/gpt-5.6-terra',
                routes: [{ provider: 'openai' }],
            },
            instructions: './instructions.md',
            skills: [],
            tools: [],
            mcps: [],
            env: {},
            runtime: 'local',
        },
    };
}

function runner(name: string): PreparedRunner {
    const candidateProviders = new Set<string>();
    return {
        name,
        failureLabel: name,
        assets: [],
        build: () => ({ command: [], cwd: '/repo', env: {} }),
        native: (_runtime, command) => ({ command, cwd: '/repo', env: {} }),
        connectionCandidates: (route) => {
            candidateProviders.add(route.provider);
            return name === 'pi' && route.provider === 'openai'
                ? [
                      {
                          provider: 'openai',
                          nativeProvider: 'openai',
                          nativeModel: route.model,
                          authenticationMethod: 'api',
                      },
                      {
                          provider: 'openai',
                          nativeProvider: 'openai-codex',
                          nativeModel: route.model,
                          authenticationMethod: 'oauth',
                      },
                  ]
                : [
                      {
                          provider: route.provider,
                          nativeProvider: route.provider,
                          nativeModel: route.model,
                      },
                  ];
        },
        inspectNativeConnections: async (prepared) => {
            const result = await prepared.execute({
                command: [],
                cwd: '/repo',
                env: {},
            });
            const output = `${result.stdout}\n${result.stderr}`;
            if (name === 'opencode') {
                return [...output.matchAll(/●\s+(OpenAI|OpenRouter)\s+(\w+)/g)]
                    .map((match) => ({
                        provider: match[1] === 'OpenAI' ? 'openai' : 'openrouter',
                        nativeProvider: match[1] === 'OpenAI' ? 'openai' : 'openrouter',
                        nativeModel:
                            match[1] === 'OpenAI'
                                ? 'gpt-5.6-terra'
                                : 'openai/gpt-5.6-terra',
                        authenticationMethod: match[2]?.toLowerCase() ?? 'native',
                    }))
                    .filter((route) => candidateProviders.has(route.provider));
            }
            if (name === 'pi' && output.includes('openai-codex')) {
                return [
                    {
                        provider: 'openai',
                        nativeProvider: 'openai-codex',
                        nativeModel: 'gpt-5.6-terra',
                        authenticationMethod: 'oauth',
                    },
                ];
            }
            if (
                name === 'claude-code' &&
                result.code === 0 &&
                output.includes('loggedIn')
            ) {
                return [
                    {
                        provider: 'anthropic',
                        nativeProvider: 'anthropic',
                        nativeModel: 'claude-sonnet-4-5',
                        authenticationMethod: 'oauth',
                    },
                ];
            }
            return [];
        },
        publicInvocation: () => ({}),
        events: () => ({
            consume: () => ({ events: [] }),
            summary: () => ({ finalText: '', turnCompleted: false }),
        }),
        startSession: () => Promise.reject(new Error('unused')),
        cleanup: async () => {},
    };
}

function runtime(
    output: string,
    overrides: Partial<PreparedRuntime> = {}
): PreparedRuntime {
    return {
        name: 'local',
        nativeAuthentication: 'persistent',
        workbench: fixture('pi'),
        workspaceDirectory: '/repo',
        environment: {},
        workspaces: [],
        pathFor: (path) => path,
        preflight: () => Promise.reject(new Error('unused')),
        execute: () => Promise.resolve({ code: 0, stdout: '', stderr: output }),
        interact: () => Promise.resolve(0),
        launch: () => ({ exited: Promise.resolve(0) }),
        launchSession: () => ({ exited: Promise.resolve(0) }),
        launchService: () => ({
            process: { exited: Promise.resolve(0) },
            resolveUrl: async (url) => url,
        }),
        cancel: () => {},
        cleanup: async () => {},
        ...overrides,
    };
}
