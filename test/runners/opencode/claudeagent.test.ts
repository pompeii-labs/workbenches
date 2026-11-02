import { afterAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ResolvedRunnerConfiguration } from '../../../src/models/index.js';
import { claudeCodeConnection } from '../../../src/runners/claude-code/connection.js';
import { RunnerContextStaging } from '../../../src/runners/context/stage.js';
import { DiskRunnerFiles } from '../../../src/runners/files/disk.js';
import {
    claudeAgentEnvironment,
    claudeAgentMethod,
    claudeAgentProviders,
} from '../../../src/runners/opencode/claudeagent.js';
import { buildOpenCodeServerInvocation } from '../../../src/runners/opencode/invocation.js';
import { OpenCodeRunner } from '../../../src/runners/opencode/runner.js';
import { OpenCodeSkillStaging } from '../../../src/runners/opencode/skills.js';
import type { PreparedRuntime } from '../../../src/runtimes/contracts.js';
import { modelCatalogFixture } from '../../model-catalog-fixture.js';
import {
    FakeOpenCodeServer,
    fixtureConfiguration,
    fixtureWorkbench,
} from './fixture.js';
import { FakeOpenCodeV2Server } from './v2fixture.js';

const root = await mkdtemp(join(tmpdir(), 'opencode-claude-agent-'));
const packageDirectory = join(root, '.workbenches', 'core');
await mkdir(packageDirectory, { recursive: true });
await writeFile(join(packageDirectory, 'instructions.md'), '# OpenCode instructions\n');
afterAll(() => rm(root, { recursive: true, force: true }));

const workbench = fixtureWorkbench(packageDirectory, root);

/** The configuration a run resolves for the Claude Agent route of `model`. */
function claudeConfiguration(model = 'claude-opus-5-5'): ResolvedRunnerConfiguration {
    return {
        ...fixtureConfiguration(workbench),
        provider: 'anthropic',
        nativeProvider: 'claude-agent',
        nativeModel: model,
        model: `claude-agent/${model}`,
        authenticationMethod: 'oauth',
    };
}

const host = {
    emit: async () => {},
    requestPermission: async () => 'reject' as const,
    requestQuestion: async () => ({ outcome: 'rejected' as const }),
};

function start(
    server: FakeOpenCodeV2Server | FakeOpenCodeServer,
    configuration = claudeConfiguration()
) {
    return server.adapter().start({
        workbench,
        workspaceDirectory: '/workspace',
        environment: {},
        configuration,
        host,
    });
}

describe('the Claude Agent method', () => {
    test('is offered on local and docker, and refused elsewhere with a reason', () => {
        for (const runtime of ['local', 'docker'] as const)
            expect(claudeAgentMethod(runtime)).toEqual({
                id: 'claude-subscription',
                label: 'Claude subscription through Claude Code (OpenCode 2.2.3 or newer, experimental)',
                nativeProvider: 'claude-agent',
                nativeMethod: 'claude-login',
                authenticationMethod: 'oauth',
                signInRunner: 'claude-code',
            });
        for (const runtime of ['e2b', 'daytona'] as const)
            expect(claudeAgentMethod(runtime).unavailable).toBe(
                `A Claude subscription through OpenCode runs only on the local and docker runtimes: ${runtime} has no Claude Code login to use. Use an Anthropic API key there instead`
            );
    });

    test('pins the exact model id, which Claude Agent may list only as an alias', () => {
        expect(claudeAgentProviders('claude-agent/claude-opus-5-5')).toEqual({
            'claude-agent': { models: { 'claude-opus-5-5': {} } },
        });
        expect(claudeAgentProviders('anthropic/claude-opus-5-5')).toBeUndefined();
        const config = (model: string) =>
            JSON.parse(
                String(
                    buildOpenCodeServerInvocation(
                        workbench,
                        'private-password',
                        {},
                        undefined,
                        '/workspace',
                        model
                    ).env.OPENCODE_CONFIG_CONTENT
                )
            );
        expect(config('claude-agent/claude-opus-5-5')).toMatchObject({
            model: 'claude-agent/claude-opus-5-5',
            providers: { 'claude-agent': { models: { 'claude-opus-5-5': {} } } },
        });
        // Every other route's config is what it was.
        expect(config('openai/gpt-5.6-terra').providers).toBeUndefined();
    });

    test('reaches the Claude Code login without a key, a gateway, or inherited settings', () => {
        const inherited = {
            PATH: '/bin',
            ANTHROPIC_API_KEY: 'placeholder-key',
            ANTHROPIC_BASE_URL: 'https://gateway.example',
            CLAUDE_CONFIG_DIR: '/elsewhere',
            CLAUDE_CODE_OAUTH_TOKEN: 'placeholder-inherited',
        };
        // On a worker, either runtime finds the member's sign-ins under the credential root.
        expect(
            claudeAgentEnvironment(
                inherited,
                { name: 'docker', credentialRoot: '/workbench-credentials' },
                undefined
            )
        ).toEqual({
            PATH: '/bin',
            CLAUDE_SECURESTORAGE_CONFIG_DIR: '/workbench-credentials/claude',
        });
        // On the host, Claude Code reads the person's own login.
        expect(claudeAgentEnvironment(inherited, { name: 'local' }, undefined)).toEqual(
            { PATH: '/bin' }
        );
        // Elsewhere, only a token from the person's own environment.
        expect(
            claudeAgentEnvironment(
                inherited,
                { name: 'docker' },
                ' placeholder-token\n'
            )
        ).toEqual({ PATH: '/bin', CLAUDE_CODE_OAUTH_TOKEN: 'placeholder-token' });
    });
});

describe('a session on the Claude Agent route', () => {
    test("records the choice of Claude Code as OpenCode's /connect does, before the session", async () => {
        const server = new FakeOpenCodeV2Server();
        server.version = '2.2.3';
        const session = await start(server);
        try {
            const connect = server.requests.findIndex(
                (request) =>
                    request.path === '/api/integration/claude-agent/connect/external'
            );
            expect(server.requests[connect]?.body).toEqual({
                methodID: 'claude-login',
            });
            expect(server.requests[connect]?.query.get('location[directory]')).toBe(
                '/workspace'
            );
            expect(connect).toBeLessThan(
                server.requests.findIndex((request) => request.path === '/api/session')
            );
            expect(
                JSON.parse(String(server.spawnEnvironment.OPENCODE_CONFIG_CONTENT))
                    .providers
            ).toEqual({ 'claude-agent': { models: { 'claude-opus-5-5': {} } } });
            server.onPrompt = () => server.completeTurn('done');
            await expect(session.prompt('work')).resolves.toEqual({ reason: 'stop' });
        } finally {
            await session.close();
        }
    });

    test('keeps a choice OpenCode already holds', async () => {
        const server = new FakeOpenCodeV2Server();
        server.version = '2.2.3';
        server.claudeAgent = {
            connections: [{ type: 'credential', method: 'external' }],
        };
        const session = await start(server);
        await session.close();
        expect(server.requests.map((request) => request.path)).not.toContain(
            '/api/integration/claude-agent/connect/external'
        );
    });

    for (const [release, version] of [
        ['OpenCode 2.2.2', '2.2.2'],
        ['OpenCode 1', undefined],
    ] as const) {
        test(`refuses ${release} before any prompt`, async () => {
            const server =
                version === undefined
                    ? new FakeOpenCodeServer()
                    : Object.assign(new FakeOpenCodeV2Server(), { version });
            await expect(start(server)).rejects.toThrow(
                `A Claude subscription through OpenCode needs OpenCode 2.2.3 or newer (npm @opencode/cli, experimental), but this runtime has OpenCode ${version ?? '1'}. Use an Anthropic API key, or install OpenCode 2.2.3 or newer`
            );
            expect(server.promptBodies).toEqual([]);
            expect(server.kills).toBe(1);
        });
    }

    test('refuses an OpenCode that did not load Claude Agent', async () => {
        const server = new FakeOpenCodeV2Server();
        server.version = '2.2.5';
        server.claudeAgent = undefined;
        await expect(start(server)).rejects.toThrow(
            'OpenCode 2.2.5 did not expose its Claude Agent provider'
        );
    });

    test('leaves every other route as it was', async () => {
        const server = new FakeOpenCodeV2Server();
        const session = await start(server, fixtureConfiguration(workbench));
        await session.close();
        expect(server.requests.map((request) => request.path)).not.toContain(
            '/api/integration'
        );
    });
});

/** A runtime that records what was launched in it. */
function runtime(name: string, credentialRoot?: string) {
    const launched: string[] = [];
    const prepared: PreparedRuntime = {
        name,
        nativeAuthentication: 'persistent',
        workbench,
        workspaceDirectory: '/workspace',
        environment: { PATH: '/bin', ANTHROPIC_API_KEY: 'placeholder-key' },
        workspaces: [],
        ...(credentialRoot ? { credentialRoot } : {}),
        pathFor: (path) => path,
        preflight: () => Promise.reject(new Error('unused')),
        execute: () => Promise.reject(new Error('unused')),
        interact: () => Promise.resolve(0),
        launch: () => ({ exited: Promise.resolve(0) }),
        launchSession: () => ({ exited: Promise.resolve(0) }),
        launchService: () => {
            launched.push('service');
            return {
                process: { exited: Promise.resolve(0) },
                resolveUrl: async (url) => url,
            };
        },
        cancel: () => {},
        cleanup: async () => {},
    };
    return { prepared, launched };
}

describe('the OpenCode runner on the Claude Agent route', () => {
    const files = new DiskRunnerFiles();
    const runner = new OpenCodeRunner({
        skills: new OpenCodeSkillStaging(files, new RunnerContextStaging(files)),
        catalog: () => modelCatalogFixture,
    });
    const prepare = () =>
        runner.prepare(workbench, { CLAUDE_CODE_OAUTH_TOKEN: 'placeholder-token' });

    test("runs Claude Code's own probe on the login the route uses, and nothing else", async () => {
        const prepared = await prepare();
        try {
            const { prepared: docker } = runtime('docker', '/workbench-credentials');
            const claude = prepared.native(docker, claudeCodeConnection.probe.command);
            expect(claude.env).toMatchObject({
                PATH: '/bin',
                CLAUDE_SECURESTORAGE_CONFIG_DIR: '/workbench-credentials/claude',
                CLAUDE_CODE_OAUTH_TOKEN: 'placeholder-token',
            });
            expect(claude.env.ANTHROPIC_API_KEY).toBeUndefined();
            // OpenCode's own commands see the runtime as before.
            const listing = prepared.native(docker, ['opencode', 'auth', 'list']);
            expect(listing.env.ANTHROPIC_API_KEY).toBe('placeholder-key');
            expect(listing.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
            expect(listing.env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBeUndefined();
        } finally {
            await prepared.cleanup();
        }
    });

    test('gives the route no Anthropic key, so the subscription pays', async () => {
        const prepared = await prepare();
        try {
            const invocation = prepared.build(
                runtime('docker').prepared,
                'work',
                claudeConfiguration()
            );
            expect(invocation.env.ANTHROPIC_API_KEY).toBeUndefined();
            expect(invocation.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('placeholder-token');
            expect(prepared.publicInvocation(invocation)).toMatchObject({
                opencode_config: { model: 'claude-agent/claude-opus-5-5' },
            });
        } finally {
            await prepared.cleanup();
        }
    });

    for (const name of ['e2b', 'daytona']) {
        test(`refuses ${name} before launching anything`, async () => {
            const prepared = await prepare();
            try {
                const { prepared: hosted, launched } = runtime(name);
                const message = `A Claude subscription through OpenCode runs only on the local and docker runtimes: ${name} has no Claude Code login to use. Use an Anthropic API key there instead`;
                expect(() =>
                    prepared.startSession(hosted, {
                        configuration: claudeConfiguration(),
                        host,
                    })
                ).toThrow(message);
                expect(() =>
                    prepared.build(hosted, 'work', claudeConfiguration())
                ).toThrow(message);
                expect(launched).toEqual([]);
            } finally {
                await prepared.cleanup();
            }
        });
    }
});
