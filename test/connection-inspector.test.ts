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
            },
            {
                provider: 'openai',
                nativeProvider: 'openai-codex',
                nativeModel: 'gpt-5.6-terra',
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

    test('refuses to inject authentication commands into the Pi TUI', async () => {
        const workbench = fixture('pi');
        let interacted = false;
        const prepared = runtime('', {
            interact() {
                interacted = true;
                return Promise.resolve(0);
            },
        });

        await expect(
            inspector(workbench, {
                runner: runner('pi'),
                runtime: prepared,
            }).connect()
        ).rejects.toThrow('Pi does not expose a command-line login operation');
        expect(interacted).toBeFalse();
    });

    test('lets the native OpenCode flow choose among multiple locked routes', async () => {
        const workbench = fixture('opencode');
        workbench.manifest.model = {
            id: 'openai/gpt-5.6-terra',
            routes: [{ provider: 'openai' }, { provider: 'openrouter' }],
        };
        let inspected = 0;
        let connected: string[] = [];
        const prepared = runtime('', {
            execute() {
                inspected += 1;
                return Promise.resolve({
                    code: 0,
                    stdout: inspected > 0 ? '● OpenRouter api\n' : '',
                    stderr: '',
                });
            },
            interact(invocation) {
                connected = invocation.command;
                return Promise.resolve(0);
            },
        });

        const status = await inspector(workbench, {
            runner: runner('opencode'),
            runtime: prepared,
        }).connect();

        expect(connected).toEqual(['opencode', 'auth', 'login']);
        expect(status.configuration?.provider).toBe('openrouter');
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

    test('reports failed and ineffective native authentication without pretending readiness', async () => {
        const workbench = fixture('opencode');
        await expect(
            inspector(workbench, {
                runner: runner('opencode'),
                runtime: runtime('', {
                    interact: () => Promise.resolve(9),
                }),
            }).connect()
        ).rejects.toThrow('OpenCode authentication exited with code 9');

        await expect(
            inspector(workbench, {
                runner: runner('opencode'),
                runtime: runtime('provider model\n'),
            }).connect()
        ).rejects.toThrow(
            'OpenCode did not report an authenticated route for openai/gpt-5.6-terra'
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
        cleanup: async () => {},
    };
}

function runtime(
    output: string,
    overrides: Partial<PreparedRuntime> = {}
): PreparedRuntime {
    return {
        name: 'local',
        workbench: fixture('pi'),
        workspaceDirectory: '/repo',
        environment: {},
        workspaces: [],
        pathFor: (path) => path,
        preflight: () => Promise.reject(new Error('unused')),
        execute: () => Promise.resolve({ code: 0, stdout: '', stderr: output }),
        interact: () => Promise.resolve(0),
        launch: () => ({ exited: Promise.resolve(0) }),
        cancel: () => {},
        cleanup: async () => {},
        ...overrides,
    };
}
