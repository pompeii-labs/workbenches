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
            'No authenticated route is available for openai/gpt-5.6-terra. Run wb connect publisher/project#core.'
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
