import { describe, expect, test } from 'bun:test';

import { AuthenticationRequiredError } from '../src/connections/error.js';
import {
    ConnectionInspector,
    type ConnectionInspectorOptions,
} from '../src/connections/inspector.js';
import { claudeCodeConnection } from '../src/runners/claude-code/connection.js';
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

    test('refuses a requested connection the routes leave out, naming those they allow', () => {
        const workbench = fixture('opencode');
        workbench.manifest.model = {
            id: 'openai/gpt-5.6-terra',
            routes: [{ provider: 'openrouter' }],
        };
        const connection = inspector(workbench, {
            runner: runner('opencode'),
            runtime: runtime('● OpenAI oauth\n'),
        });

        expect(() => connection.assertAllowed('OpenRouter')).not.toThrow();
        expect(() => connection.assertAllowed('openai')).toThrow(
            `${workbench.manifest.name} does not allow connection openai: openai/gpt-5.6-terra is routed through openrouter`
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

describe('a login another runner keeps', () => {
    const subscription = JSON.stringify({
        loggedIn: true,
        authMethod: 'claude.ai',
        subscriptionType: 'max',
    });
    const claudeAgent = {
        provider: 'anthropic',
        nativeProvider: 'claude-agent',
        authenticationMethod: 'oauth',
    };

    /** An OpenCode Workbench on Anthropic, in `name`, where `claude auth status` answers `status`. */
    function claudeRuntime(
        status: { code: number; stdout: string; stderr?: string },
        name = 'local'
    ) {
        const commands: string[][] = [];
        const prepared = runtime('', {
            name,
            execute: async (invocation) => {
                commands.push(invocation.command);
                const claude =
                    JSON.stringify(invocation.command) ===
                    JSON.stringify(claudeCodeConnection.probe.command);
                return claude
                    ? { stderr: '', ...status }
                    : { code: 0, stdout: '[]', stderr: '' };
            },
        });
        const workbench = fixture('opencode');
        workbench.manifest.model = {
            id: 'anthropic/claude-sonnet-4-5',
            routes: [{ provider: 'anthropic' }],
        };
        return {
            commands,
            claudeProbed: () =>
                commands.some(
                    (command) =>
                        JSON.stringify(command) ===
                        JSON.stringify(claudeCodeConnection.probe.command)
                ),
            inspector: inspector(workbench, {
                runner: runner('opencode'),
                runtime: prepared,
            }),
        };
    }

    test('offers Claude Agent for the pinned Anthropic model, after the native route', () => {
        const { inspector } = claudeRuntime({ code: 0, stdout: subscription });
        expect(inspector.candidates()).toEqual([
            {
                provider: 'anthropic',
                nativeProvider: 'anthropic',
                nativeModel: 'claude-sonnet-4-5',
            },
            { ...claudeAgent, nativeModel: 'claude-sonnet-4-5' },
        ]);
        inspector.assertAllowed('claude-agent');
    });

    test('asks Claude Code only when the connection is wanted', async () => {
        const local = claudeRuntime({ code: 0, stdout: subscription });
        const status = await local.inspector.inspect({ discoverConnections: true });
        expect(status.ready).toBeFalse();
        expect(local.claudeProbed()).toBeFalse();
    });

    for (const wanted of ['preferred', 'requested'] as const) {
        test(`serves a ${wanted} Claude Agent route from a Claude subscription login`, async () => {
            const local = claudeRuntime({ code: 0, stdout: subscription });
            const status = await local.inspector.inspect(
                wanted === 'preferred'
                    ? { preferredConnection: claudeAgent }
                    : { connection: 'claude-agent', discoverConnections: true }
            );
            expect(local.claudeProbed()).toBeTrue();
            expect(status.configuration).toMatchObject({
                provider: 'anthropic',
                nativeProvider: 'claude-agent',
                nativeModel: 'claude-sonnet-4-5',
                model: 'claude-agent/claude-sonnet-4-5',
                authenticationMethod: 'oauth',
            });
        });
    }

    for (const [login, stdout] of [
        ['signed out', JSON.stringify({ loggedIn: false, authMethod: 'none' })],
        [
            'signed in with a Console key',
            JSON.stringify({ loggedIn: true, authMethod: 'api_key' }),
        ],
    ] as const) {
        test(`refuses a Claude Code login that is ${login}, saying what to do`, async () => {
            const local = claudeRuntime({ code: 0, stdout });
            const inspected = local.inspector.inspect({
                preferredConnection: claudeAgent,
            });
            await expect(inspected).rejects.toBeInstanceOf(AuthenticationRequiredError);
            await expect(inspected).rejects.toThrow(
                'Claude Code in the local runtime has no subscription login for Claude subscription through Claude Code (OpenCode 2.2.3 or newer, experimental). Run claude auth login.'
            );
        });
    }

    test('refuses a runtime without Claude Code, naming the image and the sign-ins', async () => {
        const docker = claudeRuntime(
            { code: 1, stdout: '', stderr: 'sh: 1: claude: not found' },
            'docker'
        );
        await expect(
            docker.inspector.inspect({ preferredConnection: claudeAgent })
        ).rejects.toThrow(
            'Claude Code could not report its login in the docker runtime: sh: 1: claude: not found. Claude subscription through Claude Code (OpenCode 2.2.3 or newer, experimental) needs Claude Code installed there, pinned in the image, and signed in. Set CLAUDE_CODE_OAUTH_TOKEN where wb runs, or sign in to Claude Code on a worker with wb connect --worker <worker> claude-code.'
        );
    });

    for (const name of ['e2b', 'daytona']) {
        test(`refuses ${name} before asking Claude Code anything`, async () => {
            const hosted = claudeRuntime({ code: 0, stdout: subscription }, name);
            await expect(
                hosted.inspector.inspect({ preferredConnection: claudeAgent })
            ).rejects.toThrow(
                `A Claude subscription through OpenCode runs only on the local and docker runtimes: ${name} has no Claude Code login to use. Use an Anthropic API key there instead.`
            );
            expect(hosted.claudeProbed()).toBeFalse();
        });
    }
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

function fixture(runnerName: 'opencode' | 'pi'): ResolvedWorkbench {
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
    return {
        name,
        failureLabel: name,
        assets: [],
        build: () => ({ command: [], cwd: '/repo', env: {} }),
        native: (_runtime, command) => ({ command, cwd: '/repo', env: {} }),
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
