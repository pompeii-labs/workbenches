import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AuthenticationRequiredError } from '../../src/connections/error.js';
import { Connection } from '../../src/database/connection.js';
import type { OutcomeLink, RunOutcome } from '../../src/outcomes/index.js';
import { RunnerRegistry } from '../../src/runners/registry.js';
import {
    DetachedRunLauncher,
    type StartDetachedRunOptions,
} from '../../src/runs/detached.js';
import type { WorkbenchEvent } from '../../src/runs/events.js';
import type { StoredRun } from '../../src/runs/store.js';
import { readContainerForwardNames } from '../../src/runtimes/hostvariables.js';
import type { StoredSession } from '../../src/sessions/store.js';
import type { RemoteWorkbenchPackage } from '../../src/sources/index.js';
import { WorkbenchManifestParser } from '../../src/workbench/manifest.js';
import { Services } from '../../src/workbench/services.js';
import { WorkerRejection } from '../../src/workers/contracts.js';
import { packageAlias, WorkerEngine } from '../../src/workers/engine.js';
import {
    dockerAuthConfig,
    WorkerRunEnvironment,
} from '../../src/workers/environment.js';
import { WorkerHome } from '../../src/workers/home.js';
import { WorkerOutcomeArchive } from '../../src/workers/outcome.js';
import { parseServerMessage, type RunStart } from '../../src/workers/protocol.js';
import { WorkerSessionRuns } from '../../src/workers/runs.js';
import { WorkerRunnerVersions } from '../../src/workers/versions.js';
import { seedModelCatalogFixture } from '../model-catalog-fixture.js';
import { bareRepository, runStart } from './fixture.js';

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function start(overrides: Partial<RunStart> = {}): RunStart {
    const parsed = parseServerMessage(JSON.stringify(runStart(overrides)));
    if (parsed?.type !== 'run.start') throw new Error('fixture is not a run.start');
    return parsed;
}

function event(sequence: number, type: WorkbenchEvent['type']): WorkbenchEvent {
    return {
        protocol: 0,
        run_id: 'wb_engine',
        sequence,
        timestamp: '2026-01-01T00:00:00.000Z',
        type,
        runner: 'opencode',
        data: {},
    };
}

function workbenchPackage(
    manifest: Record<string, unknown> = {}
): RemoteWorkbenchPackage {
    const yaml = Bun.YAML.stringify({
        spec: 1,
        version: '0.1.0',
        name: 'threejs-game',
        runner: 'opencode',
        model: { id: 'openai/gpt-5.6-terra' },
        instructions: './instructions.md',
        runtimes: { docker: { image: 'ghcr.io/example/game:1.0.0' } },
        ...manifest,
    });
    const encoder = new TextEncoder();
    const parsed: unknown = Bun.YAML.parse(yaml);
    return {
        selector: 'version-wv-1',
        source: 'https://api.workbenches.dev/v1/workbench-versions/wv_1',
        revision: 'wv_1',
        manifest: new WorkbenchManifestParser().parse(parsed),
        files: [
            { path: 'workbench.yml', bytes: encoder.encode(yaml), executable: false },
            {
                path: 'instructions.md',
                bytes: encoder.encode('# Game\n'),
                executable: false,
            },
        ],
    };
}

async function engineHome() {
    const directory = await mkdtemp(join(tmpdir(), 'workbench-worker-engine-'));
    const home = new WorkerHome(directory);
    await home.ensure();
    await seedModelCatalogFixture(home.root);
    const connection = Connection.open(home.root);
    cleanups.push(async () => {
        connection.close();
        await rm(directory, { recursive: true, force: true });
    });
    return { home, services: new Services(home.root, connection) };
}

describe('worker engine', () => {
    test('admits one version whose package differs between sessions, as a repository run does', async () => {
        const { home, services } = await engineHome();
        const runners = RunnerRegistry.standard();
        let note = '';
        const engine = new WorkerEngine({
            worker: 'mini',
            api: 'https://api.example.test',
            home,
            services,
            runners,
            environment: new WorkerRunEnvironment(home, runners, {}),
            download: async () => {
                const base = workbenchPackage();
                return {
                    ...base,
                    files: base.files.map((file) =>
                        file.path === 'instructions.md'
                            ? {
                                  ...file,
                                  bytes: new TextEncoder().encode(`# Game\n${note}`),
                              }
                            : file
                    ),
                };
            },
        });
        await engine.admit(start({ session_id: 'ses_plain' }));
        note = 'Work in acme/game.\n';
        expect(await engine.admit(start({ session_id: 'ses_repository' }))).toEqual({
            workbench: 'threejs-game',
            runner: 'opencode',
            package: 'session-ses-repository',
        });
        // The same session again reuses its own package.
        await engine.admit(start({ session_id: 'ses_repository' }));
    });

    test('admits a package into the worker home and checks its runtime and requirements', async () => {
        const { home, services } = await engineHome();
        const runners = RunnerRegistry.standard();
        let manifest: Record<string, unknown> = {};
        const engine = new WorkerEngine({
            worker: 'mini',
            api: 'https://api.example.test',
            home,
            services,
            runners,
            environment: new WorkerRunEnvironment(home, runners, {}),
            download: async () => workbenchPackage(manifest),
        });
        expect(await engine.admit(start())).toEqual({
            workbench: 'threejs-game',
            runner: 'opencode',
            package: 'session-ses-1',
        });
        expect((await services.catalog.find('session-ses-1'))?.name).toBe(
            'threejs-game'
        );

        const local = await engine
            .admit(start({ runtime: 'local' }))
            .catch((error: Error) => error);
        expect(local).toBeInstanceOf(WorkerRejection);
        expect((local as Error).message).toContain('does not declare runtime: local');

        manifest = { requirements: { cpu: 100_000 } };
        const big = await engine
            .admit(
                start({
                    session_id: 'ses_2',
                    workbench: {
                        version_id: 'wv_2',
                        download_url: 'https://example.test/2',
                    },
                })
            )
            .catch((error: Error) => error);
        expect(big).toBeInstanceOf(WorkerRejection);
        expect((big as Error).message).toMatch(
            /needs 100000 CPUs; this worker has \d+/
        );

        // A package that declares a variable the worker sets itself is refused and not kept.
        manifest = { env: { DOCKER_HOST: { required: true } } };
        const reserved = await engine
            .admit(
                start({
                    session_id: 'ses_reserved',
                    workbench: {
                        version_id: 'wv_4',
                        download_url: 'https://example.test/4',
                    },
                })
            )
            .catch((error: Error) => error);
        expect(reserved).toBeInstanceOf(WorkerRejection);
        expect((reserved as Error).message).toContain('DOCKER_HOST');
        expect(await services.catalog.find('session-ses-reserved')).toBeUndefined();

        const missing = new WorkerEngine({
            worker: 'mini',
            api: 'https://api.example.test',
            home,
            services,
            runners,
            environment: new WorkerRunEnvironment(home, runners, {}),
            download: async () => {
                throw new Error(
                    'The Workbench package could not be downloaded (HTTP 403)'
                );
            },
        });
        expect(
            await missing
                .admit(
                    start({
                        workbench: {
                            version_id: 'wv_3',
                            download_url: 'https://example.test/3',
                        },
                    })
                )
                .catch((error: Error) => error.message)
        ).toBe(
            'The Workbench package could not be prepared: The Workbench package could not be downloaded (HTTP 403)'
        );
    });

    test('admits a local GPU run on its own GPU discovery and never on an acknowledgement', async () => {
        const { home, services } = await engineHome();
        const runners = RunnerRegistry.standard();
        const facts = {
            os: 'linux',
            arch: 'x64',
            cpus: 8,
            memoryBytes: 16 * 1024 ** 3,
        };
        const engine = (gpus: Array<{ name: string; memory_gb?: number }>) =>
            new WorkerEngine({
                worker: 'mini',
                api: 'https://api.example.test',
                home,
                services,
                runners,
                environment: new WorkerRunEnvironment(home, runners, {}),
                host: {
                    describe: () => facts,
                    gpus: async () =>
                        gpus.length
                            ? { gpus }
                            : { gpus, reason: 'nvidia-smi is not installed' },
                },
                download: async () =>
                    workbenchPackage({
                        requirements: { gpu: true },
                        runtimes: { local: {} },
                    }),
            });
        const refused = engine([]).admit(start({ runtime: 'local' }));
        await expect(refused).rejects.toBeInstanceOf(WorkerRejection);
        await expect(refused).rejects.toThrow(
            'requires a GPU but none was found: nvidia-smi is not installed'
        );
        expect(
            await engine([{ name: 'NVIDIA L4', memory_gb: 22.5 }]).admit(
                start({ runtime: 'local', session_id: 'ses_gpu' })
            )
        ).toMatchObject({ workbench: 'threejs-game' });
    });

    test('launches a detached session with the run environment held in memory', async () => {
        const { home, services } = await engineHome();
        const remote = await bareRepository();
        cleanups.push(remote.cleanup);
        const runners = RunnerRegistry.standard();
        const launched: StartDetachedRunOptions[] = [];
        const engine = new WorkerEngine({
            worker: 'mini',
            api: remote.api,
            home,
            services: {
                ...services,
                launcher: {
                    start: async (options) => {
                        launched.push(options);
                        return {
                            id: 'wb_launched',
                            session_id: 'wb_launched',
                        } as StoredRun;
                    },
                },
            },
            runners,
            environment: new WorkerRunEnvironment(
                home,
                runners,
                {
                    PATH: process.env.PATH,
                    HOME: '/home/owner',
                    GITHUB_TOKEN: 'MUST_NOT_RENDER_HOST_TOKEN',
                    GH_TOKEN: 'MUST_NOT_RENDER_HOST_TOKEN',
                    DOCKER_CONFIG: '/home/owner/.docker',
                },
                'unix:///run/docker-under-test.sock'
            ),
            download: async () => workbenchPackage(),
        });
        await engine.admit(start());
        const session = await engine.launch(
            start({
                workspace: {
                    repository: 'acme/game',
                    url: remote.url,
                    ref: remote.commit,
                    branch: 'wb/run_1',
                    credential: null,
                },
                env: {
                    OPENROUTER_API_KEY: 'MUST_NOT_RENDER_ENV_VALUE',
                    GH_HOST: 'api.example.test',
                    GH_ENTERPRISE_TOKEN: 'MUST_NOT_RENDER_PROXY_CREDENTIAL',
                    GH_PROMPT_DISABLED: '1',
                    GH_REPO: 'acme/game',
                    WORKBENCH_BRANCH: 'wb/run_1',
                    // Names the worker isolates itself are not taken from the server.
                    GH_TOKEN: 'MUST_NOT_RENDER_SERVER_TOKEN',
                    GH_CONFIG_DIR: '/MUST_NOT_RENDER_SERVER_DIRECTORY',
                },
            })
        );
        expect(session).toBe('wb_launched');
        const options = launched[0];
        expect(options).toMatchObject({
            workbench: 'session-ses-1',
            task: 'Build a pirate game with three.js',
            directory: home.workspaceDirectory('run_1'),
            runtime: 'docker',
            allowHostDocker: false,
            environmentOverrides: {
                file: { OPENROUTER_API_KEY: 'MUST_NOT_RENDER_ENV_VALUE' },
            },
        });
        // The run is a plain directory run on the cloned checkout.
        expect(options).not.toHaveProperty('repository');
        const checkout = home.workspaceDirectory('run_1');
        expect(await Bun.file(join(checkout, 'README.md')).text()).toBe('# Game\n');
        expect(await Bun.file(join(checkout, '.git', 'HEAD')).text()).toBe(
            'ref: refs/heads/wb/run_1\n'
        );
        const dockerConfig = home.dockerConfigDirectory('run_1');
        const temporary = expect.stringContaining(join(home.root, 'tmp'));
        expect(options?.environment).toEqual({
            PATH: process.env.PATH,
            HOME: '/home/owner',
            GH_TOKEN: '',
            GH_HOST: 'api.example.test',
            GH_ENTERPRISE_TOKEN: 'MUST_NOT_RENDER_PROXY_CREDENTIAL',
            GH_PROMPT_DISABLED: '1',
            GH_REPO: 'acme/game',
            WORKBENCH_BRANCH: 'wb/run_1',
            GH_CONFIG_DIR: expect.stringContaining(join(home.root, 'tmp')),
            GIT_CONFIG_NOSYSTEM: '1',
            GIT_CONFIG_GLOBAL: expect.stringContaining(join(home.root, 'tmp')),
            GIT_TERMINAL_PROMPT: '0',
            WORKBENCH_FORWARD: expect.any(String),
            WORKBENCH_CREDENTIAL_ROOT: join(home.anonymousDirectory, '.local', 'share'),
            TMPDIR: temporary,
            DOCKER_CONFIG: dockerConfig,
            DOCKER_HOST: 'unix:///run/docker-under-test.sock',
        });
        // The run's Docker client holds its own pull credential and nothing of the account's.
        expect(await Bun.file(join(dockerConfig, 'config.json')).json()).toEqual(
            dockerAuthConfig({
                registry: 'images.example.test',
                username: 'workbench',
                password: 'MUST_NOT_RENDER_IMAGE_PASSWORD',
            })
        );
        expect((await stat(join(dockerConfig, 'config.json'))).mode & 0o777).toBe(
            0o600
        );
        await engine.release('run_1');
        expect(await Bun.file(join(dockerConfig, 'config.json')).exists()).toBe(false);
    });

    test('fails a run whose repository cannot be fetched, without its credential', async () => {
        const { home, services } = await engineHome();
        const runners = RunnerRegistry.standard();
        const launched: StartDetachedRunOptions[] = [];
        const engine = new WorkerEngine({
            worker: 'mini',
            api: 'https://api.example.test',
            home,
            services: {
                ...services,
                launcher: {
                    start: async (options) => {
                        launched.push(options);
                        return { id: 'wb_launched' } as StoredRun;
                    },
                },
            },
            runners,
            environment: new WorkerRunEnvironment(home, runners, {
                PATH: process.env.PATH,
                HOME: '/home/owner',
            }),
            download: async () => workbenchPackage(),
        });
        await engine.admit(start());
        const error = await engine
            .launch(
                start({
                    workspace: {
                        repository: 'acme/game',
                        url: 'http://127.0.0.1:1/acme/game.git',
                        ref: 'main',
                        branch: 'wb/run_1',
                        credential: 'MUST_NOT_RENDER_CREDENTIAL',
                    },
                })
            )
            .catch((reason: unknown) => reason);
        expect(error).toBeInstanceOf(WorkerRejection);
        const message = error instanceof Error ? error.message : '';
        expect(message).toStartWith('The repository could not be fetched: ');
        expect(message).not.toContain('MUST_NOT_RENDER_CREDENTIAL');
        expect(launched).toEqual([]);
    });

    test('rebuilds a follow-up from the saved starting member after a restart', async () => {
        const sent: Array<Record<string, string | undefined> | undefined> = [];
        const { home, services } = await engineHome();
        const runners = RunnerRegistry.standard();
        const engine = new WorkerEngine({
            worker: 'mini',
            api: 'https://api.example.test',
            home,
            services: {
                ...services,
                control: {
                    send: async (_session, _text, _delivery, environment) => {
                        sent.push(environment);
                        return {
                            session_id: '',
                            run_id: '',
                            input_id: '',
                            after_sequence: 0,
                        };
                    },
                    answer: async () => {
                        throw new Error('unexpected');
                    },
                    cancel: async () => {
                        throw new Error('unexpected');
                    },
                },
            },
            runners,
            environment: new WorkerRunEnvironment(home, runners, {
                PATH: '/usr/bin',
                HOME: '/home/owner',
                DOCKER_HOST: 'unix:///MUST_NOT_RENDER_ACCOUNT_SOCKET',
            }),
            download: async () => workbenchPackage(),
        });
        await engine.command(
            'wb_session',
            {
                type: 'command',
                command_id: 'c',
                run_id: 'run_1',
                kind: 'send',
                payload: { text: 'Add sound' },
            },
            {
                run: {
                    run_id: 'run_1',
                    runtime: 'local',
                    member_id: 'mem_1',
                    runner: 'opencode',
                    connection: null,
                },
            }
        );
        const member = home.memberDirectory('mem_1');
        expect(sent[0]).toMatchObject({
            HOME: member,
            XDG_CONFIG_HOME: `${member}/.config`,
            XDG_DATA_HOME: `${member}/.local/share`,
            GH_TOKEN: '',
        });
        expect(JSON.stringify(sent)).not.toContain('MUST_NOT_RENDER');
    });

    test('relays commands into the session controls', async () => {
        const calls: unknown[][] = [];
        const control = {
            send: async (...args: unknown[]) => {
                calls.push(['send', ...args.slice(0, 3)]);
                return { session_id: '', run_id: '', input_id: '', after_sequence: 0 };
            },
            answer: async (...args: unknown[]) => {
                calls.push(['answer', ...args]);
                return { session_id: '', run_id: '', input_id: '', after_sequence: 0 };
            },
            cancel: async (...args: unknown[]) => {
                calls.push(['cancel', ...args]);
                return { session_id: '', run_id: '' };
            },
        };
        const { home, services } = await engineHome();
        const runners = RunnerRegistry.standard();
        const engine = new WorkerEngine({
            worker: 'mini',
            api: 'https://api.example.test',
            home,
            services: { ...services, control },
            runners,
            environment: new WorkerRunEnvironment(home, runners, {}),
            download: async () => workbenchPackage(),
        });
        const command = (
            kind: 'send' | 'steer' | 'queue' | 'answer' | 'cancel',
            payload: Record<string, unknown>
        ) =>
            engine.command(
                'wb_session',
                {
                    type: 'command',
                    command_id: 'c',
                    run_id: 'r',
                    kind,
                    payload,
                },
                {
                    run: {
                        run_id: 'r',
                        runtime: 'docker',
                        member_id: null,
                        runner: 'opencode',
                        connection: null,
                    },
                }
            );
        await command('send', { text: 'Add sound' });
        await command('steer', { text: 'Smaller' });
        await command('queue', { text: 'Then tests' });
        await command('answer', { request_id: 'req_1', response: 'allow' });
        await command('answer', { request_id: 'q_1', response: [['Blue']] });
        await command('cancel', {});
        expect(calls).toEqual([
            ['send', 'wb_session', 'Add sound', 'send'],
            ['send', 'wb_session', 'Smaller', 'steer'],
            ['send', 'wb_session', 'Then tests', 'queue'],
            ['answer', 'wb_session', 'req_1', 'allow'],
            ['answer', 'wb_session', 'q_1', '[["Blue"]]'],
            ['cancel', 'wb_session'],
        ]);
        expect(await command('send', {}).catch((error: Error) => error.message)).toBe(
            'send requires payload.text'
        );
        expect(
            await command('answer', { request_id: 'x', response: 3 }).catch(
                (error: Error) => error.message
            )
        ).toContain('payload.response');
    });

    test('keeps forwarding a repository run its gh variables into the container on a continuation', async () => {
        const sent: Array<Record<string, string | undefined>> = [];
        const control = {
            send: async (...args: unknown[]) => {
                const environment = args[3];
                if (typeof environment === 'object' && environment !== null)
                    sent.push(Object.fromEntries(Object.entries(environment)));
                return { session_id: '', run_id: '', input_id: '', after_sequence: 0 };
            },
            answer: async () => ({
                session_id: '',
                run_id: '',
                input_id: '',
                after_sequence: 0,
            }),
            cancel: async () => ({ session_id: '', run_id: '' }),
        };
        const { home, services } = await engineHome();
        const runners = RunnerRegistry.standard();
        const engine = new WorkerEngine({
            worker: 'mini',
            api: 'https://api.example.test',
            home,
            services: { ...services, control },
            runners,
            environment: new WorkerRunEnvironment(home, runners, {
                PATH: process.env.PATH,
                HOME: '/home/owner',
            }),
            download: async () => workbenchPackage(),
        });
        const repositoryStart = start({
            workspace: {
                repository: 'acme/game',
                url: 'https://api.example.test/acme/game.git',
                ref: 'main',
                branch: 'wb/run_1',
                credential: 'MUST_NOT_RENDER_CREDENTIAL',
            },
            env: {
                GH_HOST: 'api.example.test',
                GH_ENTERPRISE_TOKEN: 'MUST_NOT_RENDER_PROXY_CREDENTIAL',
                GH_REPO: 'acme/game',
                WORKBENCH_BRANCH: 'wb/run_1',
            },
        });
        await engine.admit(repositoryStart);
        await engine.command(
            'wb_session',
            {
                type: 'command',
                command_id: 'c',
                run_id: 'run_1',
                kind: 'send',
                payload: { text: 'Fix the tests' },
            },
            {
                run: {
                    run_id: 'run_1',
                    runtime: 'docker',
                    member_id: null,
                    runner: 'opencode',
                    connection: null,
                },
                start: repositoryStart,
            }
        );
        const environment = sent[0] ?? {};
        const names = readContainerForwardNames(environment);
        expect(names.toSorted()).toEqual([
            'GH_ENTERPRISE_TOKEN',
            'GH_HOST',
            'GH_REPO',
            'GH_TOKEN',
            'GIT_TERMINAL_PROMPT',
            'WORKBENCH_BRANCH',
        ]);
        expect(environment.GH_ENTERPRISE_TOKEN).toBe(
            'MUST_NOT_RENDER_PROXY_CREDENTIAL'
        );
        // Host paths stay on the host.
        expect(names).not.toContain('GIT_CONFIG_GLOBAL');
        expect(names).not.toContain('GH_CONFIG_DIR');
    });

    test("passes preflight only with the member's sign-in or the run's keys", async () => {
        const { home, services } = await engineHome();
        const bin = await mkdtemp(join(tmpdir(), 'workbench-worker-claude-'));
        cleanups.push(() => rm(bin, { recursive: true, force: true }));
        // A Claude Code with no login of its own, as in the member's empty home,
        // that reports a subscription token in its environment the way the real one does.
        await writeFile(
            join(bin, 'claude'),
            [
                '#!/bin/sh',
                'if [ "$1" = "--version" ]; then echo "2.1.292 (Claude Code)"; exit 0; fi',
                'if [ "$1" = "auth" ] && [ -n "$CLAUDE_CODE_OAUTH_TOKEN" ]; then echo \'{"loggedIn":true,"authMethod":"oauth_token"}\'; exit 0; fi',
                'if [ "$1" = "auth" ]; then echo \'{"loggedIn":false}\'; exit 1; fi',
                'exit 1',
            ].join('\n'),
            { mode: 0o755 }
        );
        const runners = RunnerRegistry.standard();
        const prepared: Array<Record<string, string | undefined> | undefined> = [];
        const connections: Array<string | undefined> = [];
        const engine = new WorkerEngine({
            worker: 'mini',
            api: 'https://api.example.test',
            home,
            services: {
                ...services,
                // Real resolution and preflight; nothing is dispatched.
                launcher: new DetachedRunLauncher(home.root, {
                    prepare: async (options) => {
                        prepared.push(options.environment);
                        connections.push(options.connection);
                        throw new Error('preflight passed');
                    },
                    dispatch: async () => 0,
                }),
            },
            runners,
            environment: new WorkerRunEnvironment(home, runners, {
                PATH: `${bin}:/usr/bin:/bin`,
                HOME: '/home/owner',
            }),
            download: async () =>
                workbenchPackage({
                    runner: 'claude-code',
                    model: { id: 'anthropic/claude-sonnet-4-5' },
                    runtimes: { local: {} },
                }),
            versions: new WorkerRunnerVersions(async () => '2.1.292 (Claude Code)'),
        });
        const run = (overrides: Partial<RunStart> = {}) => {
            const local = start({
                runtime: 'local',
                image_pull: null,
                env: {},
                ...overrides,
            });
            return engine
                .admit(local)
                .then(() => engine.launch(local))
                .catch((error: unknown) => error);
        };
        const message = (value: unknown) =>
            value instanceof Error ? value.message : String(value);

        const neither = await run();
        expect(neither).toBeInstanceOf(AuthenticationRequiredError);
        expect(message(neither)).toMatch(
            /^No authenticated route is available for [^ ]+\. Run wb connect --worker mini claude-code\.$/
        );
        expect(prepared).toEqual([]);

        const keyed = await run({ env: { ANTHROPIC_API_KEY: 'sk-ant-placeholder' } });
        expect(message(keyed)).toBe('preflight passed');

        await home.saveMember({ id: 'mem_1', name: 'matty' });
        await home.saveMemberConnection('mem_1', 'claude-code', {
            provider: 'anthropic',
            method: 'native',
            variable: 'CLAUDE_CODE_OAUTH_TOKEN',
            secret: 'sk-ant-oat01-placeholder',
        });
        const signedIn = await run({ started_by: { member_id: 'mem_1' } });
        expect(message(signedIn)).toBe('preflight passed');
        expect(prepared[1]?.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat01-placeholder');
        // Another member's run never gets it.
        const other = await run({ started_by: { member_id: 'mem_2' } });
        expect(other).toBeInstanceOf(AuthenticationRequiredError);
        expect(connections).toEqual([undefined, 'anthropic']);

        // A member connection the Workbench cannot use fails the run, which
        // says how to connect, and never falls back to the run's keys.
        await home.saveMemberConnection('mem_1', 'claude-code', {
            provider: 'xai',
            method: 'api-key',
            variable: 'XAI_API_KEY',
            secret: 'MUST_NOT_RENDER_UNUSABLE_KEY',
        });
        const unusable = await run({
            started_by: { member_id: 'mem_1' },
            env: { ANTHROPIC_API_KEY: 'sk-ant-placeholder' },
        });
        expect(unusable).toBeInstanceOf(AuthenticationRequiredError);
        expect(message(unusable)).toEndWith(
            'Run wb connect --worker mini claude-code.'
        );
        expect(prepared).toHaveLength(2);
    });

    test("refuses a Workbench that declares a variable the engine owns, so it never reads the machine's", async () => {
        const { home, services } = await engineHome();
        const runners = RunnerRegistry.standard();
        const engine = new WorkerEngine({
            worker: 'mini',
            api: 'https://api.example.test',
            home,
            services,
            runners,
            environment: new WorkerRunEnvironment(home, runners, {}),
            download: async () =>
                workbenchPackage({
                    env: { GH_TOKEN: { required: true }, HOME: { required: true } },
                }),
        });
        const refused = await engine.admit(start()).catch((error: unknown) => error);
        expect(refused).toBeInstanceOf(WorkerRejection);
        expect(refused instanceof Error ? refused.message : '').toContain(
            'reserved variables the engine sets itself: GH_TOKEN, HOME'
        );
    });

    test('refuses a local run on a runner CLI older than it works with, but not a container run', async () => {
        const { home, services } = await engineHome();
        const runners = RunnerRegistry.standard();
        const engine = new WorkerEngine({
            worker: 'mini',
            api: 'https://api.example.test',
            home,
            services,
            runners,
            environment: new WorkerRunEnvironment(home, runners, {
                PATH: '/usr/bin',
                HOME: '/home/owner',
            }),
            download: async () =>
                workbenchPackage({
                    runner: 'claude-code',
                    model: { id: 'anthropic/claude-sonnet-4-5' },
                    runtimes: {
                        docker: { image: 'ghcr.io/example/claude:1.0.0' },
                        local: {},
                    },
                }),
            versions: new WorkerRunnerVersions(async () => '2.1.221 (Claude Code)'),
        });
        const local = await engine
            .admit(start({ runtime: 'local', image_pull: null }))
            .catch((error: unknown) => error);
        expect(local).toBeInstanceOf(WorkerRejection);
        expect(local instanceof Error ? local.message : '').toBe(
            'Claude Code 2.1.221 on this worker is older than 2.1.292, the oldest release Workbench works with. Update it on the worker.'
        );
        // A container brings its own Claude Code.
        expect(await engine.admit(start({ runtime: 'docker' }))).toMatchObject({
            runner: 'claude-code',
        });
    });

    test("gives only the member's runs their latest connection, local and docker, unless a run asks for another", async () => {
        const { home, services } = await engineHome();
        const runners = RunnerRegistry.standard();
        const launched: StartDetachedRunOptions[] = [];
        const sent: Array<{
            environment: Record<string, string | undefined> | undefined;
            connection: string | undefined;
        }> = [];
        const engine = new WorkerEngine({
            worker: 'mini',
            api: 'https://api.example.test',
            home,
            services: {
                ...services,
                launcher: {
                    start: async (options) => {
                        launched.push(options);
                        return {
                            id: 'wb_launched',
                            session_id: 'wb_launched',
                        } as StoredRun;
                    },
                },
                control: {
                    send: async (
                        _session,
                        _text,
                        _delivery,
                        environment,
                        connection
                    ) => {
                        sent.push({ environment, connection });
                        return {
                            session_id: '',
                            run_id: '',
                            input_id: '',
                            after_sequence: 0,
                        };
                    },
                    answer: async () => {
                        throw new Error('unexpected');
                    },
                    cancel: async () => {
                        throw new Error('unexpected');
                    },
                },
            },
            runners,
            environment: new WorkerRunEnvironment(home, runners, {
                PATH: '/usr/bin',
                HOME: '/home/owner',
            }),
            download: async () =>
                workbenchPackage({
                    runner: 'claude-code',
                    model: { id: 'anthropic/claude-sonnet-4-5' },
                    runtimes: {
                        local: {},
                        docker: { image: 'ghcr.io/example/game:1.0.0' },
                    },
                }),
            versions: new WorkerRunnerVersions(async () => '2.1.292 (Claude Code)'),
        });
        await home.saveMember({ id: 'mem_1', name: 'matty' });
        const launch = async (overrides: Partial<RunStart>) => {
            const run = start({
                runtime: 'local',
                image_pull: null,
                env: { OPENROUTER_API_KEY: 'organization-key' },
                started_by: { member_id: 'mem_1' },
                ...overrides,
            });
            await engine.admit(run);
            await engine.launch(run);
            const options = launched.at(-1);
            return {
                connection: options?.connection,
                environment: options?.environment ?? {},
                keys: options?.environmentOverrides.file ?? {},
            };
        };
        const runtimes = ['local', 'docker'] as const;

        const keysOnly = await launch({});
        expect(keysOnly.connection).toBeUndefined();
        expect(keysOnly.keys.OPENROUTER_API_KEY).toBe('organization-key');

        // An API key: the provider's own variable, ahead of the organization's key.
        await home.saveMemberConnection('mem_1', 'claude-code', {
            provider: 'openrouter',
            method: 'api-key',
            variable: 'OPENROUTER_API_KEY',
            secret: 'MUST_NOT_RENDER_MEMBER_KEY',
        });
        for (const runtime of runtimes) {
            const keyed = await launch({ runtime });
            expect(keyed.connection).toBe('openrouter');
            expect(keyed.environment.OPENROUTER_API_KEY).toBe(
                'MUST_NOT_RENDER_MEMBER_KEY'
            );
            expect(keyed.keys.OPENROUTER_API_KEY).toBeUndefined();
        }
        // Never another member's run.
        for (const runtime of runtimes) {
            const other = await launch({ runtime, started_by: { member_id: 'mem_2' } });
            expect(other.connection).toBeUndefined();
            expect(other.keys.OPENROUTER_API_KEY).toBe('organization-key');
            expect(JSON.stringify(other)).not.toContain('MUST_NOT_RENDER');
        }

        // A subscription token, the most recent connection, replaces the key as the default.
        await home.saveMemberConnection('mem_1', 'claude-code', {
            provider: 'anthropic',
            method: 'native',
            variable: 'CLAUDE_CODE_OAUTH_TOKEN',
            secret: 'sk-ant-oat01-MUST_NOT_RENDER_MEMBER_TOKEN',
        });
        for (const runtime of runtimes) {
            const signedIn = await launch({ runtime });
            expect(signedIn.connection).toBe('anthropic');
            expect(signedIn.environment.CLAUDE_CODE_OAUTH_TOKEN).toBe(
                'sk-ant-oat01-MUST_NOT_RENDER_MEMBER_TOKEN'
            );
            expect(signedIn.keys.OPENROUTER_API_KEY).toBe('organization-key');
            expect(JSON.stringify(signedIn)).not.toContain(
                'MUST_NOT_RENDER_MEMBER_KEY'
            );
        }
        for (const runtime of runtimes) {
            const other = await launch({ runtime, started_by: { member_id: 'mem_2' } });
            expect(JSON.stringify(other)).not.toContain('MUST_NOT_RENDER');
        }

        // A run that asks for the organization's keys never sees the member's credential.
        const asked = await launch({ connection: 'openrouter' });
        expect(asked.connection).toBe('openrouter');
        expect(JSON.stringify(asked)).not.toContain('MUST_NOT_RENDER');
        expect(asked.keys.OPENROUTER_API_KEY).toBe('organization-key');

        // A follow-up rebuilt after a restart uses the same connection.
        const followUp = (connection: string | null) =>
            engine.command(
                'wb_launched',
                {
                    type: 'command',
                    command_id: 'c',
                    run_id: 'run_1',
                    kind: 'send',
                    payload: { text: 'Add sound' },
                },
                {
                    run: {
                        run_id: 'run_1',
                        runtime: 'docker',
                        member_id: 'mem_1',
                        runner: 'claude-code',
                        connection,
                    },
                }
            );
        await followUp(null);
        expect(sent.at(-1)?.connection).toBe('anthropic');
        expect(sent.at(-1)?.environment?.CLAUDE_CODE_OAUTH_TOKEN).toBe(
            'sk-ant-oat01-MUST_NOT_RENDER_MEMBER_TOKEN'
        );
        await followUp('openrouter');
        expect(sent.at(-1)?.connection).toBe('openrouter');
        expect(JSON.stringify(sent.at(-1))).not.toContain('MUST_NOT_RENDER');
    });

    test("uses a member's OpenCode sign-in in their local and docker runs, never another member's", async () => {
        const { home, services } = await engineHome();
        const runners = RunnerRegistry.standard();
        const launched: StartDetachedRunOptions[] = [];
        const engine = new WorkerEngine({
            worker: 'mini',
            api: 'https://api.example.test',
            home,
            services: {
                ...services,
                launcher: {
                    start: async (options) => {
                        launched.push(options);
                        return {
                            id: 'wb_launched',
                            session_id: 'wb_launched',
                        } as StoredRun;
                    },
                },
            },
            runners,
            environment: new WorkerRunEnvironment(home, runners, {
                PATH: '/usr/bin',
                HOME: '/home/owner',
            }),
            download: async () =>
                workbenchPackage({
                    runtimes: {
                        local: {},
                        docker: { image: 'ghcr.io/example/game:1.0.0' },
                    },
                }),
            versions: new WorkerRunnerVersions(async () => '2.1.292 (Claude Code)'),
        });
        await home.saveMember({ id: 'mem_1', name: 'matty' });
        await home.saveMemberConnection('mem_1', 'opencode', {
            provider: 'github-copilot',
            method: 'native',
        });
        const launch = async (overrides: Partial<RunStart>) => {
            const run = start({
                image_pull: null,
                env: {},
                started_by: { member_id: 'mem_1' },
                ...overrides,
            });
            await engine.admit(run);
            await engine.launch(run);
            return launched.at(-1);
        };
        const local = await launch({ runtime: 'local' });
        expect(local?.connection).toBe('github-copilot');
        expect(local?.environment?.XDG_DATA_HOME).toBe(
            `${home.memberDirectory('mem_1')}/.local/share`
        );
        // A docker run mounts the same sign-ins.
        const docker = await launch({ runtime: 'docker' });
        expect(docker?.connection).toBe('github-copilot');
        expect(docker?.environment?.WORKBENCH_CREDENTIAL_ROOT).toBe(
            `${home.memberDirectory('mem_1')}/.local/share`
        );
        for (const runtime of ['local', 'docker']) {
            const other = await launch({
                runtime,
                started_by: { member_id: 'mem_2' },
            });
            expect(other?.connection).toBeUndefined();
            expect(other?.environment?.WORKBENCH_CREDENTIAL_ROOT).toBe(
                `${home.memberDirectory('mem_2')}/.local/share`
            );
        }
    });

    test('numbers a session consecutively across its runs and reads only new events', async () => {
        const stored = new Map<
            string,
            { run: Partial<StoredRun>; events: WorkbenchEvent[] }
        >([
            [
                'wb_first',
                {
                    run: { id: 'wb_first', status: 'completed' },
                    events: [event(1, 'run.started'), event(2, 'run.completed')],
                },
            ],
            [
                'wb_second',
                {
                    run: {
                        id: 'wb_second',
                        status: 'running',
                        resumed_from: 'wb_first',
                    },
                    events: [event(1, 'run.started'), event(2, 'output.text')],
                },
            ],
        ]);
        const reads: Array<[string, number]> = [];
        const find = (id: string) => {
            const entry = stored.get(id);
            if (!entry) throw new Error(`no run ${id}`);
            return entry;
        };
        const runs = new WorkerSessionRuns({
            runs: {
                read: async (id) => ({ ...find(id).run }) as StoredRun,
                readEventsAfter: async (id, sequence) => {
                    reads.push([id, sequence]);
                    return find(id).events.filter((entry) => entry.sequence > sequence);
                },
                lastEvent: async (id) => find(id).events.at(-1),
            },
            sessions: {
                read: async () => ({ latest_run_id: 'wb_second' }) as StoredSession,
            },
        });
        expect(
            (await runs.events('wb_first', 0)).map((entry) => [
                entry.sequence,
                entry.type,
            ])
        ).toEqual([
            [1, 'run.started'],
            [2, 'run.completed'],
            [3, 'run.started'],
            [4, 'output.text'],
        ]);
        find('wb_second').events.push(event(3, 'run.completed'));
        reads.length = 0;
        expect(
            (await runs.events('wb_first', 4)).map((entry) => entry.sequence)
        ).toEqual([5]);
        // The finished first run is not read again, and the second only past the cursor.
        expect(reads).toEqual([['wb_second', 2]]);
        expect(await runs.ids('wb_first')).toEqual(['wb_first', 'wb_second']);
    });

    test('names package aliases and pull requests', () => {
        expect(packageAlias('wbs_01HX9Z')).toBe('session-wbs-01hx9z');
        expect(() => packageAlias('___')).toThrow('invalid session');
        const links: OutcomeLink[] = [
            {
                id: 'l1',
                label: 'Preview',
                uri: 'https://example.test/preview',
                kind: 'preview',
            },
            {
                id: 'l2',
                label: 'PR',
                uri: 'https://github.com/acme/game/pull/12',
                kind: 'pull_request',
            },
        ];
        expect(WorkerOutcomeArchive.pullRequest({ links } as RunOutcome)).toBe(12);
    });
});

const environmentRoot = await mkdtemp(join(tmpdir(), 'workbench-worker-environment-'));
afterAll(() => rm(environmentRoot, { recursive: true, force: true }));

describe('worker run environment', () => {
    const home = new WorkerHome(environmentRoot);
    const worker = home.root;
    const runners = RunnerRegistry.standard();
    const base = {
        PATH: '/usr/bin',
        HOME: '/home/owner',
        GH_TOKEN: 'MUST_NOT_RENDER_HOST_TOKEN',
        DOCKER_HOST: 'unix:///MUST_NOT_RENDER_ACCOUNT_SOCKET',
        DOCKER_CONTEXT: 'MUST_NOT_RENDER_ACCOUNT_CONTEXT',
    };
    const local = (memberId: string | null) => ({
        run_id: 'run_1',
        runtime: 'local',
        member_id: memberId,
        image_pull: null,
        repository: {},
    });

    test('runs a local run in the starting member home', async () => {
        const environment = await new WorkerRunEnvironment(home, runners, base).build(
            local('mem_1'),
            'opencode'
        );
        const member = `${worker}/members/mem_1`;
        expect(environment).toMatchObject({
            PATH: '/usr/bin',
            HOME: member,
            XDG_CONFIG_HOME: `${member}/.config`,
            XDG_DATA_HOME: `${member}/.local/share`,
            XDG_STATE_HOME: `${member}/.local/state`,
            OPENCODE_DB: `${member}/.local/share/opencode/opencode.db`,
        });
        expect(JSON.stringify(environment)).not.toContain('MUST_NOT_RENDER');
    });

    test("points a local run at the machine's Docker daemon, never the account's Docker settings", async () => {
        const environment = await new WorkerRunEnvironment(
            home,
            runners,
            base,
            'unix:///run/docker-under-test.sock'
        ).build(local('mem_1'), 'opencode');
        expect(environment.TMPDIR?.startsWith(`${worker}/tmp/`)).toBe(true);
        expect(environment.DOCKER_HOST).toBe('unix:///run/docker-under-test.sock');
        expect(environment.DOCKER_CONTEXT).toBeUndefined();
    });

    test('keeps git and gh off the account configuration in a local run', async () => {
        const environment = await new WorkerRunEnvironment(home, runners, {
            ...base,
            GH_CONFIG_DIR: '/home/owner/MUST_NOT_RENDER_ACCOUNT_GH',
            GIT_CONFIG_GLOBAL: '/home/owner/MUST_NOT_RENDER_ACCOUNT_GITCONFIG',
        }).build(local('mem_1'), 'opencode');
        const temporary = environment.TMPDIR ?? '';
        expect(environment).toMatchObject({
            GH_TOKEN: '',
            GIT_CONFIG_NOSYSTEM: '1',
            GIT_CONFIG_GLOBAL: join(temporary, 'gitconfig'),
            GH_CONFIG_DIR: join(temporary, 'gh'),
            GIT_TERMINAL_PROMPT: '0',
        });
        // Empty and the run's own, so nothing of the account's is in either.
        expect(await Bun.file(join(temporary, 'gitconfig')).text()).toBe('');
        expect(await readdir(join(temporary, 'gh'))).toEqual([]);
    });

    test('never gives a local run without a member the account sign-ins', async () => {
        const environment = await new WorkerRunEnvironment(home, runners, {
            ...base,
            CLAUDE_CODE_OAUTH_TOKEN: 'MUST_NOT_RENDER_ACCOUNT_TOKEN',
        }).build(local(null), 'claude-code');
        expect(environment.HOME).toBe(`${worker}/members/_none`);
        expect(environment.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
        // Set and empty: the engine never asks the account's GitHub CLI instead.
        expect(environment.GH_TOKEN).toBe('');
    });

    test('gives a docker run a Docker client of its own without the account login', async () => {
        const { home: writable } = await engineHome();
        const environment = await new WorkerRunEnvironment(
            writable,
            runners,
            base,
            'unix:///run/docker-under-test.sock'
        ).build({ ...local(null), runtime: 'docker' }, 'opencode');
        expect(environment).toEqual({
            PATH: '/usr/bin',
            HOME: '/home/owner',
            GH_TOKEN: '',
            GH_CONFIG_DIR: expect.stringContaining(join(writable.root, 'tmp')),
            GIT_CONFIG_NOSYSTEM: '1',
            GIT_CONFIG_GLOBAL: expect.stringContaining(join(writable.root, 'tmp')),
            GIT_TERMINAL_PROMPT: '0',
            TMPDIR: expect.stringContaining(join(writable.root, 'tmp')),
            WORKBENCH_CREDENTIAL_ROOT: join(
                writable.anonymousDirectory,
                '.local',
                'share'
            ),
            DOCKER_CONFIG: writable.dockerConfigDirectory('run_1'),
            DOCKER_HOST: 'unix:///run/docker-under-test.sock',
        });
        expect(
            await Bun.file(
                join(writable.dockerConfigDirectory('run_1'), 'config.json')
            ).json()
        ).toEqual({});
    });

    test("signs a member in as their local runs run, with Claude Code's login kept in their sign-ins", async () => {
        const { home: writable } = await engineHome();
        const environment = new WorkerRunEnvironment(writable, runners, base);
        const member = writable.memberDirectory('mem_1');
        const signIn = await environment.signIn('con_1', member, 'claude-code');
        expect(signIn).toMatchObject({
            HOME: member,
            XDG_DATA_HOME: `${member}/.local/share`,
            CLAUDE_SECURESTORAGE_CONFIG_DIR: `${member}/.local/share/claude`,
            TMPDIR: expect.stringContaining(join(writable.root, 'tmp')),
        });
        expect(signIn).not.toHaveProperty('DOCKER_HOST');
        // Every other runner keeps its login where its own environment points.
        expect(
            await environment.signIn('con_2', member, 'opencode')
        ).not.toHaveProperty('CLAUDE_SECURESTORAGE_CONFIG_DIR');
        await environment.release('con_1');
        await expect(stat(String(signIn.TMPDIR))).rejects.toThrow('ENOENT');
    });

    test('encodes the image pull credential for the Docker client', () => {
        expect(
            dockerAuthConfig({
                registry: 'images.example.test',
                username: 'u',
                password: 'p',
            })
        ).toEqual({
            auths: {
                'images.example.test': { auth: Buffer.from('u:p').toString('base64') },
            },
        });
    });
});
