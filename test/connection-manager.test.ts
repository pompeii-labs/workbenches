import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConnectionInspector } from '../src/connections/inspector.js';
import {
    ConnectionManager,
    type ConnectionManagerOptions,
    type RunnerSelect,
} from '../src/connections/manager.js';
import { ConnectionStore } from '../src/connections/store.js';
import type { PreparedRunner } from '../src/runners/runner.js';
import type { PreparedRuntime } from '../src/runtimes/contracts.js';
import type { ResolvedWorkbench } from '../src/types.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories
            .splice(0)
            .map((directory) => rm(directory, { recursive: true, force: true }))
    );
});

describe('runner connection selection', () => {
    test('asks which compatible credential should be active and remembers it', async () => {
        const home = await temporaryHome();
        const workbench = fixture('opencode');
        workbench.manifest.model = {
            id: 'openai/gpt-5.6-terra',
            routes: [{ provider: 'openai' }, { provider: 'openrouter' }],
        };
        let prompted = 0;
        const status = await configure({
            workbench,
            runner: runner('opencode'),
            runtime: runtime('● OpenAI oauth\n● OpenRouter api\n'),
            reference: 'project-core',
            home,
            choose: async (options) => {
                prompted += 1;
                expect(options.allowConnect).toBeTrue();
                const connection = options.connections.find(
                    (candidate) => candidate.provider === 'openrouter'
                );
                if (!connection) throw new Error('missing OpenRouter fixture');
                return { kind: 'connection', connection };
            },
        });

        expect(prompted).toBe(1);
        expect(status.configuration).toMatchObject({
            provider: 'openrouter',
            nativeProvider: 'openrouter',
        });
        expect(
            await new ConnectionStore(home).find(
                ConnectionStore.context(workbench, 'project-core')
            )
        ).toEqual({ provider: 'openrouter', nativeProvider: 'openrouter' });
        const remembered = await new ConnectionInspector({
            workbench,
            runner: runner('opencode'),
            runtime: runtime('● OpenAI oauth\n● OpenRouter api\n'),
            reference: 'project-core',
            store: new ConnectionStore(home),
        }).inspect();
        expect(remembered.configuration?.provider).toBe('openrouter');
    });

    test('can add a new native connection instead of silently reusing one', async () => {
        const home = await temporaryHome();
        const workbench = fixture('opencode');
        workbench.manifest.model = {
            id: 'openai/gpt-5.6-terra',
            routes: [{ provider: 'openai' }, { provider: 'openrouter' }],
        };
        let inspected = 0;
        let loginCommand: string[] = [];
        const prepared = runtime('', {
            execute: async () => {
                inspected += 1;
                return {
                    code: 0,
                    stdout:
                        inspected === 1
                            ? '● OpenAI oauth\n'
                            : '● OpenAI oauth\n● OpenRouter api\n',
                    stderr: '',
                };
            },
            interact: async (invocation) => {
                loginCommand = invocation.command;
                return 0;
            },
        });

        const status = await configure({
            workbench,
            runner: runner('opencode'),
            runtime: prepared,
            reference: 'project-core',
            home,
            choose: async () => ({ kind: 'connect' }),
            chooseProvider: async (options) => {
                const provider = options.providers.find(
                    (candidate) => candidate.provider === 'openrouter'
                );
                if (!provider) throw new Error('missing OpenRouter fixture');
                return provider;
            },
            announce: () => {},
        });

        expect(loginCommand).toEqual([
            'opencode',
            'auth',
            'login',
            '--provider',
            'openrouter',
        ]);
        expect(status.configuration?.provider).toBe('openrouter');
    });

    test('distinguishes a Codex subscription from OpenAI API authentication', async () => {
        const home = await temporaryHome();
        const workbench = fixture('pi');
        const status = await configure({
            workbench,
            runner: runner('pi'),
            runtime: runtime(
                'provider model\nopenai gpt-5.6-terra\nopenai-codex gpt-5.6-terra\n'
            ),
            reference: 'project-core',
            home,
            choose: async (options) => {
                expect(options.allowConnect).toBeFalse();
                const connection = options.connections.find(
                    (candidate) => candidate.nativeProvider === 'openai-codex'
                );
                if (!connection) throw new Error('missing Codex fixture');
                return { kind: 'connection', connection };
            },
        });

        expect(status.connections).toHaveLength(2);
        expect(status.configuration).toMatchObject({
            provider: 'openai',
            nativeProvider: 'openai-codex',
        });
        expect(
            ConnectionManager.connectionLabel({
                provider: 'openai',
                nativeProvider: 'openai-codex',
                nativeModel: 'gpt-5.6-terra',
            })
        ).toBe('OpenAI Codex subscription');
    });

    test('does not offer an interactive Pi login when no connection exists', async () => {
        const home = await temporaryHome();
        const workbench = fixture('pi');

        await expect(
            configure({
                workbench,
                runner: runner('pi'),
                runtime: runtime('provider model\n'),
                reference: 'project-core',
                home,
            })
        ).rejects.toThrow('Pi does not expose a command-line login operation');
    });

    test('connects the first compatible credential and asks when several were added', async () => {
        const home = await temporaryHome();
        const workbench = fixture('opencode');
        workbench.manifest.model = {
            id: 'openai/gpt-5.6-terra',
            routes: [{ provider: 'openai' }, { provider: 'openrouter' }],
        };
        let inspected = 0;
        const prepared = runtime('', {
            execute: async () => {
                inspected += 1;
                return {
                    code: 0,
                    stdout: inspected === 1 ? '' : '● OpenAI oauth\n● OpenRouter api\n',
                    stderr: '',
                };
            },
        });

        const status = await configure({
            workbench,
            runner: runner('opencode'),
            runtime: prepared,
            reference: 'project-core',
            home,
            chooseProvider: async (options) => {
                const openRouter = options.providers.find(
                    (provider) => provider.provider === 'openrouter'
                );
                if (!openRouter) throw new Error('missing OpenRouter fixture');
                return openRouter;
            },
            announce: () => {},
        });

        expect(status.configuration?.provider).toBe('openrouter');
    });

    test('accepts successful reauthorization of an existing connection', async () => {
        const home = await temporaryHome();
        const workbench = fixture('opencode');
        let loginCommand: string[] = [];
        const announcements: string[] = [];
        const prepared = runtime('● OpenAI oauth\n', {
            interact: async (invocation) => {
                loginCommand = invocation.command;
                return 0;
            },
        });

        const status = await configure({
            workbench,
            runner: runner('opencode'),
            runtime: prepared,
            reference: 'project-core',
            home,
            choose: async () => ({ kind: 'connect' }),
            announce: (message) => announcements.push(message),
        });

        expect(loginCommand).toEqual([
            'opencode',
            'auth',
            'login',
            '--provider',
            'openai',
        ]);
        expect(status.configuration?.provider).toBe('openai');
        expect(announcements.join('\n')).toContain(
            'Choose a sign-in method in the next prompt: API key or ChatGPT Plus/Pro'
        );
        expect(announcements.join('\n')).toContain(
            'Workbench does not copy or store the credential'
        );
    });

    test('rejects authentication that does not connect the selected provider', async () => {
        const home = await temporaryHome();
        const workbench = fixture('opencode');
        workbench.manifest.model = {
            id: 'openai/gpt-5.6-terra',
            routes: [{ provider: 'openai' }, { provider: 'openrouter' }],
        };
        let inspected = 0;
        const prepared = runtime('', {
            execute: async () => ({
                code: 0,
                stdout: inspected++ === 0 ? '' : '● OpenRouter api\n',
                stderr: '',
            }),
        });

        await expect(
            configure({
                workbench,
                runner: runner('opencode'),
                runtime: prepared,
                reference: 'project-core',
                home,
                chooseProvider: async (options) => {
                    const openai = options.providers.find(
                        (provider) => provider.provider === 'openai'
                    );
                    if (!openai) throw new Error('missing OpenAI fixture');
                    return openai;
                },
                announce: () => {},
            })
        ).rejects.toThrow('did not report a compatible openai connection');
    });

    test('renders the interactive connection menu with current-state hints', async () => {
        let observed: Parameters<RunnerSelect>[0] | undefined;
        const connections = [
            { provider: 'openai', nativeProvider: 'openai', nativeModel: 'terra' },
            {
                provider: 'openrouter',
                nativeProvider: 'openrouter',
                nativeModel: 'terra',
            },
        ];

        const selected = await ConnectionManager.promptConnection(
            {
                runner: 'opencode',
                model: 'openai/gpt-5.6-terra',
                connections,
                current: { provider: 'openrouter', nativeProvider: 'openrouter' },
                allowConnect: true,
            },
            async (options) => {
                observed = options;
                return 1;
            }
        );
        const openRouterConnection = connections[1];
        if (!openRouterConnection) throw new Error('missing OpenRouter fixture');

        expect(selected).toEqual({
            kind: 'connection',
            connection: openRouterConnection,
        });
        expect(observed?.message).toBe('Choose a connection for openai/gpt-5.6-terra');
        expect(observed?.options).toEqual([
            { value: 0, label: 'OpenAI', hint: 'connected' },
            { value: 1, label: 'OpenRouter', hint: 'current' },
            {
                value: 2,
                label: 'Add or update a connection',
                hint: 'uses OpenCode sign-in',
            },
        ]);
        expect(observed?.initialValue).toBe(1);
    });

    test('renders only eligible providers and explains their credential methods', async () => {
        let observed: Parameters<RunnerSelect>[0] | undefined;
        const provider = await ConnectionManager.promptProvider(
            {
                runner: 'opencode',
                model: 'openai/gpt-5.6-terra',
                providers: [
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
                    {
                        provider: 'azure',
                        nativeProvider: 'azure',
                        nativeModel: 'gpt-5.6-terra',
                    },
                    {
                        provider: 'abacus',
                        nativeProvider: 'abacus',
                        nativeModel: 'gpt-5.6-terra',
                    },
                ],
            },
            async (options) => {
                observed = options;
                return 0;
            }
        );

        expect(provider.nativeProvider).toBe('openai');
        expect(observed?.options).toEqual([
            {
                value: 0,
                label: 'OpenAI',
                hint: 'API key or ChatGPT Plus/Pro',
            },
            { value: 1, label: 'OpenRouter', hint: 'API key' },
            { value: 2, label: 'Abacus' },
            { value: 3, label: 'Azure' },
        ]);
        expect(observed?.placeholder).toBe('Type to search providers');
        expect(observed?.maxItems).toBe(7);
    });

    test('rejects non-interactive and cancelled connection menus', async () => {
        await expect(
            ConnectionManager.promptConnection({
                runner: 'custom-runner',
                model: 'private/model',
                connections: [],
                allowConnect: false,
            })
        ).rejects.toThrow('requires an interactive terminal');

        await expect(
            ConnectionManager.promptConnection(
                {
                    runner: 'custom-runner',
                    model: 'private/model',
                    connections: [],
                    allowConnect: true,
                },
                async () => Symbol('cancel')
            )
        ).rejects.toThrow('selection cancelled');

        expect(
            ConnectionManager.connectionLabel({
                provider: 'private-cloud',
                nativeProvider: 'gateway',
                nativeModel: 'deployment',
            })
        ).toBe('Private Cloud through Gateway');
    });
});

function configure(options: ConnectionManagerOptions) {
    return new ConnectionManager(options).configure();
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
        execute: () => Promise.resolve({ code: 0, stdout: output, stderr: '' }),
        interact: () => Promise.resolve(0),
        launch: () => ({ exited: Promise.resolve(0) }),
        cancel: () => {},
        cleanup: async () => {},
        ...overrides,
    };
}

async function temporaryHome(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'workbench-runner-connect-'));
    temporaryDirectories.push(directory);
    return directory;
}
