import { afterEach, describe, expect, test } from 'bun:test';
import {
    chmod,
    lstat,
    mkdir,
    mkdtemp,
    readFile,
    rm,
    stat,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter } from 'node:path';
import type {
    ModelCatalogSnapshot,
    ResolvedRunnerConfiguration,
} from '../../../src/models/index.js';
import { join } from '../../../src/platform/paths.js';
import { ClaudeCodeConfigStaging } from '../../../src/runners/claude-code/config.js';
import { runtimeCostStore } from '../../../src/runners/claude-code/cost.js';
import {
    executeOnHost as executeFixture,
    executeOnHost,
} from '../../../src/runners/claude-code/process.js';
import {
    ClaudeCodeRunner,
    type PreparedClaudeCodeRunner,
} from '../../../src/runners/claude-code/runner.js';
import { RunnerContextStaging } from '../../../src/runners/context/stage.js';
import { DiskRunnerFiles } from '../../../src/runners/files/disk.js';
import type {
    RunnerSession,
    RunnerSessionContext,
    RunnerSessionHost,
} from '../../../src/runners/session.js';
import type { WorkbenchEventDraft } from '../../../src/runs/events.js';
import type { PreparedRuntime } from '../../../src/runtimes/contracts.js';
import { DiskAssetSource } from '../../../src/runtimes/staging/disk.js';
import type {
    ResolvedWorkbench,
    RunnerInvocation,
    WorkbenchWorkspaceBinding,
} from '../../../src/types.js';
import { modelCatalogFixture } from '../../model-catalog-fixture.js';
import { diskMode, executableScript, symlink } from '../../platform.js';
import { FakeClaudeCode } from './fixture.js';

const catalog: ModelCatalogSnapshot = {
    ...modelCatalogFixture,
    providers: {
        ...modelCatalogFixture.providers,
        vercel: { env: ['AI_GATEWAY_API_KEY'] },
    },
};

/** Stages under the test scratch prefix, never the person's temporary directory. */
class ScratchFiles extends DiskRunnerFiles {
    override tempDirectory(prefix: string): Promise<string> {
        return mkdtemp(join(tmpdir(), `b3-${prefix}`));
    }
}

const scratch: string[] = [];
const prepared: PreparedClaudeCodeRunner[] = [];
const sessions: RunnerSession[] = [];

afterEach(async () => {
    await Promise.all(sessions.splice(0).map((session) => session.close()));
    await Promise.all(prepared.splice(0).map((runner) => runner.cleanup()));
    await Promise.all(
        scratch.splice(0).map((path) => rm(path, { recursive: true, force: true }))
    );
});

/** A package with one skill and a workspace with a CLAUDE.md, on disk. */
async function project() {
    const root = await mkdtemp(join(tmpdir(), 'b3-runner-'));
    scratch.push(root);
    const packageDirectory = join(root, 'package');
    const workspace = join(root, 'workspace');
    await mkdir(join(packageDirectory, 'skills', 'review'), { recursive: true });
    await mkdir(workspace);
    await writeFile(join(packageDirectory, 'instructions.md'), '# Review carefully\n');
    await writeFile(join(packageDirectory, 'skills', 'review', 'SKILL.md'), 'Review.');
    await writeFile(join(workspace, 'CLAUDE.md'), 'Use tabs.');
    const workbench = {
        manifestPath: join(packageDirectory, 'workbench.yml'),
        packageDirectory,
        repositoryDirectory: workspace,
        instructionsPath: join(packageDirectory, 'instructions.md'),
        skills: [
            {
                name: 'review',
                directory: join(packageDirectory, 'skills', 'review'),
                manifestPath: join(packageDirectory, 'skills', 'review', 'SKILL.md'),
            },
        ],
        manifest: {
            spec: 1,
            version: '0.1.0',
            name: 'reviewer',
            runner: 'claude-code',
            model: { id: 'anthropic/claude-sonnet-4-5' },
            instructions: './instructions.md',
            skills: ['./skills/review'],
            tools: [],
            mcps: [],
            env: {},
            runtimes: { local: {} },
        },
    } as unknown as ResolvedWorkbench;
    return { root, workspace, workbench };
}

function runner(platform: NodeJS.Platform = 'darwin'): ClaudeCodeRunner {
    const files = new ScratchFiles();
    return new ClaudeCodeRunner({
        config: new ClaudeCodeConfigStaging(
            files,
            new RunnerContextStaging(files),
            new DiskAssetSource()
        ),
        catalog: () => catalog,
        platform,
    });
}

async function prepare(
    workbench: ResolvedWorkbench,
    host: Record<string, string | undefined> = {},
    platform?: NodeJS.Platform
): Promise<PreparedClaudeCodeRunner> {
    const ready = (await runner(platform).prepare(
        workbench,
        host
    )) as PreparedClaudeCodeRunner;
    prepared.push(ready);
    return ready;
}

/** A resolved route. Anthropic defaults to a login `claude auth status` reported as a subscription. */
function configuration(
    provider: string,
    authenticationMethod = provider === 'anthropic' ? 'oauth' : undefined
): ResolvedRunnerConfiguration {
    const model =
        provider === 'anthropic' ? 'claude-sonnet-4-5' : 'anthropic/claude-sonnet-4.5';
    return {
        runner: 'claude-code',
        canonicalModel: 'anthropic/claude-sonnet-4-5',
        model: `${provider}/${model}`,
        provider,
        nativeProvider: provider,
        nativeModel: model,
        routes: [],
        ...(authenticationMethod ? { authenticationMethod } : {}),
    };
}

interface FakeRuntimeOptions {
    workbench: ResolvedWorkbench;
    workspace: string;
    environment?: Record<string, string | undefined>;
    workspaces?: WorkbenchWorkspaceBinding[];
    /** Maps host paths into the runtime. Identity on local. */
    mount?: (path: string) => string;
}

/** A runtime that records launches and keeps runtime files in memory. */
function fakeRuntime(name: string, options: FakeRuntimeOptions) {
    const launched: RunnerInvocation[] = [];
    const executed: RunnerInvocation[] = [];
    const files = new Map<string, string>();
    const natives: FakeClaudeCode[] = [];
    const mount = options.mount ?? ((path: string) => path);
    const runtime = {
        name,
        workbench: options.workbench,
        workspaceDirectory: mount(options.workspace),
        environment: {
            PATH: '/usr/bin:/bin',
            WORKBENCH_OUTPUT_DIR: '/runs/r1/outbox',
            ...options.environment,
        },
        workspaces: options.workspaces ?? [],
        pathFor: mount,
        execute: async (invocation: RunnerInvocation) => {
            executed.push(invocation);
            if (invocation.env.WORKBENCH_COST_PATH) {
                const path = invocation.env.WORKBENCH_COST_PATH;
                const value = invocation.env.WORKBENCH_COST_VALUE;
                if (value !== undefined) files.set(path, `${value}\n`);
                return { code: 0, stdout: files.get(path) ?? '', stderr: '' };
            }
            const [, , script, , path, value] = invocation.command;
            if (script?.startsWith('cat') && path) {
                return { code: 0, stdout: files.get(path) ?? '', stderr: '' };
            }
            if (path && value !== undefined) files.set(path, `${value}\n`);
            return { code: 0, stdout: '', stderr: '' };
        },
        launchSession: (invocation: RunnerInvocation) => {
            launched.push(invocation);
            const native = new FakeClaudeCode();
            native.scenario = 'manual';
            natives.push(native);
            return native.spawn(invocation.command, {
                cwd: invocation.cwd,
                env: invocation.env,
                stdin: 'pipe',
                stdout: 'pipe',
                stderr: 'pipe',
            });
        },
        cancel: (process: { kill(): void }) => process.kill(),
    } as unknown as PreparedRuntime;
    return { runtime, launched, executed, files, natives };
}

function host(events: WorkbenchEventDraft[] = []): RunnerSessionHost {
    return {
        emit: async (event) => void events.push(event),
        requestPermission: async () => 'reject',
        requestQuestion: async () => ({ outcome: 'rejected' }),
    };
}

async function start(
    ready: PreparedClaudeCodeRunner,
    runtime: PreparedRuntime,
    provider = 'anthropic',
    session?: RunnerSessionContext,
    events: WorkbenchEventDraft[] = [],
    authenticationMethod?: string
): Promise<RunnerSession> {
    const started = await ready.startSession(runtime, {
        configuration: configuration(provider, authenticationMethod),
        host: host(events),
        ...(session ? { session } : {}),
    });
    sessions.push(started);
    return started;
}

/** The `claude` argv inside the launch wrappers. */
function claudeArguments(invocation: RunnerInvocation): string[] {
    let command = invocation.command;
    while (command.includes('-EncodedCommand')) {
        const script = Buffer.from(
            command[command.indexOf('-EncodedCommand') + 1] as string,
            'base64'
        ).toString('utf16le');
        const launch = script
            .split('\n')
            .findLast((line) => line.startsWith('& ') || line.includes(' | & '));
        if (!launch) break;
        command = [...launch.matchAll(/'((?:[^']|'')*)'/g)].map((match) =>
            (match[1] as string).replaceAll("''", "'")
        );
    }
    return command.slice(
        command.findIndex(
            (value) =>
                value
                    .replaceAll('\\', '/')
                    .split('/')
                    .at(-1)
                    ?.replace(/\.exe$/i, '') === 'claude'
        )
    );
}

function claudeEnvironment(invocation: RunnerInvocation): Record<string, unknown> {
    return Object.fromEntries(
        Object.entries(invocation.env).filter(
            ([name]) => name.startsWith('CLAUDE') || name.startsWith('ANTHROPIC')
        )
    );
}

function flag(command: string[], name: string): string | undefined {
    const index = command.indexOf(name);
    return index < 0 ? undefined : command[index + 1];
}

describe('Claude Code runner preparation', () => {
    test('stages one read-write config directory and removes it on cleanup', async () => {
        const { workbench } = await project();
        const ready = await prepare(workbench);
        const [asset] = ready.assets;

        expect(ready.assets).toHaveLength(1);
        expect(asset?.access).toBe('read-write');
        expect(asset?.path).toStartWith(join(tmpdir(), 'b3-workbench-claude-'));
        expect(
            (await stat(join(asset?.path ?? '', 'skills', 'review'))).isDirectory()
        ).toBe(true);
        await ready.cleanup();
        prepared.splice(0);
        expect(await lstat(asset?.path ?? '').catch(() => undefined)).toBeUndefined();
    });
});

describe('Claude Code runner launches', () => {
    test('local: a subscription session in the session state, with grants, scrubbing, and context', async () => {
        const { root, workspace, workbench } = await project();
        const ready = await prepare(workbench, {
            CLAUDE_CODE_OAUTH_TOKEN: 'host-oauth-token',
            ANTHROPIC_BASE_URL: 'https://inherited.invalid',
        });
        const docs = join(root, 'docs');
        const permissionDocs =
            process.platform === 'win32'
                ? `/${docs[0]?.toLowerCase()}/${docs.slice(3).replaceAll('\\', '/')}`
                : docs;
        const { runtime, launched } = fakeRuntime('local', {
            workbench,
            workspace,
            environment: {
                CLAUDECODE: '1',
                ANTHROPIC_BASE_URL: 'https://inherited.invalid',
            },
            workspaces: [{ name: 'docs', path: docs, access: 'read-write' }],
        });
        const events: WorkbenchEventDraft[] = [];
        const state = join(root, 'session');
        await start(
            ready,
            runtime,
            'anthropic',
            { id: 'wb_1', directory: state, nativeSessionId: 'native-1' },
            events
        );
        const [invocation] = launched;
        if (!invocation) throw new Error('no launch');
        const command = claudeArguments(invocation);

        if (process.platform === 'win32')
            expect(invocation.command).toContain('-EncodedCommand');
        else expect(invocation.command.slice(0, 2)).toEqual(['/bin/sh', '-c']);
        if (process.platform === 'win32')
            expect(invocation.env.WORKBENCH_RUNTIME_CONTEXT).toBeDefined();
        else {
            expect(invocation.command).toContain('workbench-context');
            expect(invocation.command).toContain('workbench-claude');
        }
        expect(flag(command, '--model')).toBe('claude-sonnet-4-5');
        expect(flag(command, '--resume')).toBe('native-1');
        expect(flag(command, '--system-prompt-snapshot')).toBe('off');
        expect(flag(command, '--permission-prompt-tool')).toBe('stdio');
        expect(
            command.filter((_, index) => command[index - 1] === '--add-dir')
        ).toEqual(['/runs/r1/outbox', docs]);
        expect(JSON.parse(flag(command, '--settings') ?? '')).toEqual({
            permissions: {
                allow: [
                    'Read(//runs/r1/outbox/**)',
                    'Edit(//runs/r1/outbox/**)',
                    `Read(/${permissionDocs}/**)`,
                    `Edit(/${permissionDocs}/**)`,
                ],
                deny: [],
            },
        });
        expect(claudeEnvironment(invocation)).toEqual({
            CLAUDE_CODE_OAUTH_TOKEN: 'host-oauth-token',
            CLAUDE_CONFIG_DIR: join(state, 'claude-code'),
            CLAUDE_SECURESTORAGE_CONFIG_DIR: '',
            CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
            CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1',
        });
        expect(invocation.env.WORKBENCH_CLAUDE_SKILLS).toBe(
            join(ready.assets[0]?.path ?? '', 'skills')
        );
        // The local workspace's CLAUDE.md reaches the staged prompt prefix.
        expect(
            await readFile(invocation.env.WORKBENCH_CONTEXT_PREFIX ?? '', 'utf8')
        ).toContain('Use tabs.');
        expect(events).toEqual([]);
    });

    test('local Linux keeps scrubbing off, and a gateway never reads the person login', async () => {
        const { workspace, workbench } = await project();
        const ready = await prepare(workbench, {}, 'linux');
        const { runtime, launched } = fakeRuntime('local', {
            workbench,
            workspace,
            environment: {
                OPENROUTER_API_KEY: 'openrouter-key',
                ANTHROPIC_API_KEY: 'unused',
            },
        });
        await start(ready, runtime, 'openrouter');
        const [invocation] = launched;
        if (!invocation) throw new Error('no launch');
        const configDirectory = ready.assets[0]?.path;

        expect(flag(claudeArguments(invocation), '--model')).toBe(
            'anthropic/claude-sonnet-4.5'
        );
        expect(flag(claudeArguments(invocation), '--session-id')).toBeDefined();
        // Without a Workbench session there is nothing to keep, so no state wrapper.
        expect(invocation.command).not.toContain('workbench-claude');
        expect(claudeEnvironment(invocation)).toEqual({
            ANTHROPIC_BASE_URL: 'https://openrouter.ai/api',
            ANTHROPIC_AUTH_TOKEN: 'openrouter-key',
            ANTHROPIC_API_KEY: '',
            CLAUDE_CONFIG_DIR: configDirectory,
            CLAUDE_SECURESTORAGE_CONFIG_DIR: configDirectory,
            CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
            CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '0',
        });
    });

    test('docker: runtime paths, an API key or a host token, and no login', async () => {
        const { workspace, workbench } = await project();
        const mount = (path: string) =>
            path.startsWith(join(tmpdir(), 'b3-workbench-claude-'))
                ? `/runner/${path.slice(tmpdir().length).replaceAll('\\', '/').replace(/^\//, '')}`
                : path === workspace
                  ? '/workspace'
                  : path;
        const keyed = await prepare(workbench, {
            CLAUDE_CODE_OAUTH_TOKEN: 'host-oauth-token',
        });
        const withKey = fakeRuntime('docker', {
            workbench,
            workspace,
            mount,
            environment: { ANTHROPIC_API_KEY: 'anthropic-key' },
        });
        await start(keyed, withKey.runtime, 'anthropic', {
            id: 'wb_2',
            directory: '/state/wb_2',
        });
        const [api] = withKey.launched;
        if (!api) throw new Error('no launch');
        expect(claudeEnvironment(api)).toEqual({
            ANTHROPIC_API_KEY: 'anthropic-key',
            CLAUDE_CONFIG_DIR: '/state/wb_2/claude-code',
            CLAUDE_SECURESTORAGE_CONFIG_DIR: '/state/wb_2/claude-code',
            CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
            CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '0',
        });
        expect(api.cwd).toBe('/workspace');
        expect(flag(claudeArguments(api), '--mcp-config')).toStartWith(
            '/runner/b3-workbench-claude-'
        );
        expect(api.env.WORKBENCH_CLAUDE_SKILLS).toStartWith(
            '/runner/b3-workbench-claude-'
        );

        const withToken = fakeRuntime('docker', { workbench, workspace, mount });
        await start(keyed, withToken.runtime);
        const [subscription] = withToken.launched;
        if (!subscription) throw new Error('no launch');
        expect(subscription.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('host-oauth-token');
        expect(subscription.env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toStartWith(
            '/runner/'
        );
        expect(subscription.env.ANTHROPIC_API_KEY).toBeUndefined();
    });

    for (const remote of ['e2b', 'daytona']) {
        test(`${remote}: an API key or the person's own token, never a login`, async () => {
            const { workspace, workbench } = await project();
            const unauthenticated = await prepare(workbench);
            const none = fakeRuntime(remote, { workbench, workspace });
            await expect(start(unauthenticated, none.runtime)).rejects.toThrow(
                `Claude Code on the ${remote} runtime needs ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN`
            );
            expect(none.launched).toEqual([]);

            const ready = await prepare(workbench, {
                CLAUDE_CODE_OAUTH_TOKEN: 'host-oauth-token',
            });
            const subscribed = fakeRuntime(remote, { workbench, workspace });
            await start(ready, subscribed.runtime);
            const [subscription] = subscribed.launched;
            if (!subscription) throw new Error('no launch');
            expect(claudeEnvironment(subscription)).toEqual({
                CLAUDE_CODE_OAUTH_TOKEN: 'host-oauth-token',
                CLAUDE_CONFIG_DIR: ready.assets[0]?.path,
                CLAUDE_SECURESTORAGE_CONFIG_DIR: ready.assets[0]?.path,
                CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
                CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '0',
            });

            const keyed = fakeRuntime(remote, {
                workbench,
                workspace,
                environment: {
                    ANTHROPIC_API_KEY: 'anthropic-key',
                    CLAUDE_CODE_OAUTH_TOKEN: 'declared-oauth-token',
                },
            });
            await start(ready, keyed.runtime);
            const [invocation] = keyed.launched;
            if (!invocation) throw new Error('no launch');
            expect(claudeEnvironment(invocation)).toEqual({
                ANTHROPIC_API_KEY: 'anthropic-key',
                CLAUDE_CONFIG_DIR: ready.assets[0]?.path,
                CLAUDE_SECURESTORAGE_CONFIG_DIR: ready.assets[0]?.path,
                CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
                CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '0',
            });
            expect(JSON.stringify(invocation)).not.toContain('oauth-token');
        });
    }

    test('skips repository instructions silently where the workspace is not on the host', async () => {
        const { workspace, workbench } = await project();
        const ready = await prepare(workbench);
        const events: WorkbenchEventDraft[] = [];
        const { runtime, launched } = fakeRuntime('docker', {
            workbench,
            workspace,
            environment: { ANTHROPIC_API_KEY: 'anthropic-key' },
            workspaces: [{ name: 'docs', path: 'relative/docs', access: 'read-only' }],
        });
        await start(ready, runtime, 'anthropic', undefined, events);

        // Only the workspace rule warns; the capability table documents the skipped instructions.
        expect(events).toEqual([
            {
                type: 'runner.event',
                data: {
                    native_type: 'warning',
                    message:
                        'No file rule granted for the workspace docs: its path is not a plain absolute path',
                },
            },
        ]);
        expect(
            await readFile(launched[0]?.env.WORKBENCH_CONTEXT_PREFIX ?? '', 'utf8')
        ).not.toContain('Use tabs.');
    });
});

describe('Claude Code credential probe environment', () => {
    test('local reads the person login and a host token, never an inherited key', async () => {
        const { workspace, workbench } = await project();
        const ready = await prepare(workbench, {
            CLAUDE_CODE_OAUTH_TOKEN: 'host-oauth-token',
        });
        const { runtime } = fakeRuntime('local', {
            workbench,
            workspace,
            environment: { ANTHROPIC_API_KEY: 'anthropic-key', CLAUDECODE: '1' },
        });
        const probe = ready.native(runtime, ['claude', 'auth', 'status', '--json']);

        expect(probe.command).toEqual(['claude', 'auth', 'status', '--json']);
        expect(claudeEnvironment(probe)).toEqual({
            CLAUDE_CONFIG_DIR: ready.assets[0]?.path,
            CLAUDE_SECURESTORAGE_CONFIG_DIR: '',
            CLAUDE_CODE_OAUTH_TOKEN: 'host-oauth-token',
        });
    });

    for (const remote of ['e2b', 'daytona']) {
        test(`${remote} reads only the empty session store, with the person's own token`, async () => {
            const { workspace, workbench } = await project();
            const ready = await prepare(workbench, {
                CLAUDE_CODE_OAUTH_TOKEN: 'host-oauth-token',
            });
            const { runtime } = fakeRuntime(remote, {
                workbench,
                workspace,
                environment: { CLAUDE_CODE_OAUTH_TOKEN: 'declared-oauth-token' },
            });

            expect(claudeEnvironment(ready.native(runtime, ['claude']))).toEqual({
                CLAUDE_CONFIG_DIR: ready.assets[0]?.path,
                CLAUDE_SECURESTORAGE_CONFIG_DIR: ready.assets[0]?.path,
                CLAUDE_CODE_OAUTH_TOKEN: 'host-oauth-token',
            });
        });
    }
});

describe('Claude Code cost across processes', () => {
    async function turn(session: RunnerSession, native: FakeClaudeCode, total: number) {
        const answered = new Set(
            native.lines
                .filter((value) => value.type === 'user')
                .map((value) => value.uuid)
        );
        const prompt = session.prompt('work');
        const line = await native.waitFor(
            (value) => value.type === 'user' && !answered.has(value.uuid)
        );
        const command = String(line.uuid);
        native.turn(command);
        native.finishTurn(command, { total_cost_usd: total });
        await prompt;
    }

    function costs(events: WorkbenchEventDraft[]): unknown[] {
        return events
            .filter((event) => event.type === 'usage.updated')
            .map((event) => event.data.cost_usd);
    }

    test('a resumed process reports deltas from the total the last one recorded', async () => {
        const { workspace, workbench } = await project();
        const ready = await prepare(workbench);
        const fake = fakeRuntime('docker', {
            workbench,
            workspace,
            environment: { ANTHROPIC_API_KEY: 'anthropic-key' },
        });
        const context = { id: 'wb_3', directory: '/state/wb_3' };
        const first: WorkbenchEventDraft[] = [];
        const session1 = await start(ready, fake.runtime, 'anthropic', context, first);
        await turn(session1, fake.natives[0] as FakeClaudeCode, 0.02);
        await turn(session1, fake.natives[0] as FakeClaudeCode, 0.03);
        await session1.close();
        expect(costs(first)).toEqual([0.02, expect.closeTo(0.01)]);
        expect(fake.files.get('/state/wb_3/claude-code/workbench-cost.json')).toBe(
            '{"total_cost_usd":0.03}\n'
        );

        const second: WorkbenchEventDraft[] = [];
        const session2 = await start(
            ready,
            fake.runtime,
            'anthropic',
            { ...context, nativeSessionId: 'native-3' },
            second
        );
        await turn(session2, fake.natives[1] as FakeClaudeCode, 0.045);
        await session2.close();
        expect(costs(second)).toEqual([expect.closeTo(0.015)]);
        // Every record goes through the runtime, never the host disk.
        expect(
            fake.executed.every(
                (invocation) =>
                    (invocation.command[0] === '/bin/sh' ||
                        invocation.command.includes('-EncodedCommand')) &&
                    invocation.env.ANTHROPIC_API_KEY === undefined
            )
        ).toBe(true);
    });

    test('the cost file round-trips through a real shell', async () => {
        const root = await mkdtemp(join(tmpdir(), 'b3-cost-'));
        scratch.push(root);
        const store = runtimeCostStore(
            {
                execute: executeOnHost,
                workspaceDirectory: root,
                environment: {
                    PATH: '/usr/bin:/bin',
                    ANTHROPIC_API_KEY: 'never-passed',
                },
            },
            join(root, 'state', 'claude-code', 'workbench-cost.json')
        );

        expect(await store.read()).toBeUndefined();
        await store.write(0.125);
        await store.write(0.25);
        expect(await store.read()).toBe(0.25);
        expect(
            await readFile(
                join(root, 'state', 'claude-code', 'workbench-cost.json'),
                'utf8'
            )
        ).toBe('{"total_cost_usd":0.25}\n');
    });

    test('a subscription session reports no spend', async () => {
        const { workspace, workbench } = await project();
        const ready = await prepare(workbench);
        const fake = fakeRuntime('local', { workbench, workspace });
        const events: WorkbenchEventDraft[] = [];
        const session = await start(
            ready,
            fake.runtime,
            'anthropic',
            undefined,
            events
        );
        await turn(session, fake.natives[0] as FakeClaudeCode, 0.4);
        expect(costs(events)).toEqual([0]);
    });

    test('a Console login reads the person login and reports its metered cost', async () => {
        const { workspace, workbench } = await project();
        const ready = await prepare(workbench);
        const fake = fakeRuntime('local', { workbench, workspace });
        const events: WorkbenchEventDraft[] = [];
        const session = await start(
            ready,
            fake.runtime,
            'anthropic',
            undefined,
            events,
            'api'
        );
        expect(fake.launched[0]?.env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe('');
        await turn(session, fake.natives[0] as FakeClaudeCode, 0.4);
        expect(costs(events)).toEqual([0.4]);
    });
});

describe('Claude Code launch wrappers on a real shell', () => {
    /** A `claude` that reports its config directory, skills, prompt, and input, then exits. */
    async function fakeClaude(root: string): Promise<string> {
        const bin = join(root, 'bin');
        await mkdir(bin);
        const path = join(bin, 'claude');
        await writeFile(
            path,
            [
                '#!/usr/bin/env bun',
                'const args = process.argv.slice(2);',
                'const prompt = args[args.indexOf("--append-system-prompt-file") + 1];',
                'const fs = await import("node:fs/promises");',
                'const path = await import("node:path");',
                'const config = process.env.CLAUDE_CONFIG_DIR;',
                'const skills = await fs.readdir(path.join(config, "skills"));',
                'const text = await fs.readFile(prompt, "utf8");',
                'const input = await Bun.stdin.text();',
                'await fs.writeFile(process.env.WORKBENCH_TEST_REPORT, "config=" + config + "\\n" + skills.join("\\n") + "\\n" + text + "\\ninput=" + input.trimEnd() + "\\n");',
            ].join('\n')
        );
        await executableScript(path);
        return bin;
    }

    async function run(invocation: RunnerInvocation): Promise<void> {
        const result = await executeFixture(invocation);
        if (result.code !== 0) throw new Error(result.stderr);
    }

    test('keeps native state, replaces skills without following a link, and writes fresh context', async () => {
        const { root, workspace, workbench } = await project();
        const bin = await fakeClaude(root);
        const report = join(root, 'report.txt');
        const ready = await prepare(workbench);
        const { runtime, launched } = fakeRuntime('local', {
            workbench,
            workspace,
            environment: {
                PATH: `${bin}${delimiter}${process.platform === 'win32' ? `${process.env.SystemRoot}\\System32` : '/usr/bin:/bin'}`,
                WORKBENCH_TEST_REPORT: report,
            },
        });
        const state = join(root, 'state');
        await start(ready, runtime, 'anthropic', { id: 'wb_4', directory: state });
        const [first] = launched;
        if (!first) throw new Error('no launch');
        await run(first);
        const config = join(state, 'claude-code');
        expect(await readFile(report, 'utf8')).toContain(`config=${config}\nreview\n`);
        expect(await readFile(report, 'utf8')).toContain('<workbench_runtime>');
        expect(await readFile(report, 'utf8')).toContain('Use tabs.');
        // The copied directories are made writable, never with the sealed source mode:
        // Docker Desktop's file sharing refuses to change a read-only directory it made.
        for (const directory of [
            join(config, 'skills'),
            join(config, 'skills', 'review'),
        ]) {
            expect((await stat(directory)).mode & 0o200).toBe(0o200);
        }
        expect(
            await readFile(join(config, 'skills', 'review', 'SKILL.md'), 'utf8')
        ).toBe('Review.');

        // Native state survives; a skills entry swapped for a link is removed, not followed.
        await mkdir(join(config, 'projects'), { recursive: true });
        await writeFile(join(config, 'projects', 'session.jsonl'), '{}\n');
        await writeFile(join(config, 'settings.json'), '{"hooks":{}}');
        await writeFile(join(config, 'CLAUDE.md'), 'Planted.');
        await writeFile(join(config, 'workbench-cost.json'), '{"total_cost_usd":1}\n');
        const outside = join(root, 'outside');
        await mkdir(outside);
        await writeFile(join(outside, 'keep.md'), 'keep');
        await chmod(outside, 0o555);
        await rm(join(config, 'skills'), { recursive: true, force: true });
        await symlink(outside, join(config, 'skills'));
        // Every user-level entry a process may have planted goes, read-only or linked.
        const planted = [
            'agents',
            'commands',
            'hooks',
            'plugins',
            'output-styles',
            'workflows',
            'routines',
            'rules',
        ];
        for (const entry of planted) {
            await mkdir(join(config, entry, 'nested'), { recursive: true });
            await writeFile(join(config, entry, 'nested', 'planted.md'), 'Planted.');
            await chmod(join(config, entry, 'nested'), 0o555);
        }
        await symlink(outside, join(config, 'themes'));
        await run(first);
        for (const entry of [...planted, 'themes']) {
            expect(await lstat(join(config, entry)).catch(() => undefined)).toBe(
                undefined
            );
        }
        expect(await readFile(join(config, 'workbench-cost.json'), 'utf8')).toBe(
            '{"total_cost_usd":1}\n'
        );

        expect((await lstat(join(config, 'skills'))).isDirectory()).toBe(true);
        expect(
            await readFile(join(config, 'skills', 'review', 'SKILL.md'), 'utf8')
        ).toBe('Review.');
        expect(await readFile(join(config, 'projects', 'session.jsonl'), 'utf8')).toBe(
            '{}\n'
        );
        expect(await lstat(join(config, 'settings.json')).catch(() => undefined)).toBe(
            undefined
        );
        expect(await lstat(join(config, 'CLAUDE.md')).catch(() => undefined)).toBe(
            undefined
        );
        expect(await readFile(join(outside, 'keep.md'), 'utf8')).toBe('keep');
        expect((await stat(outside)).mode & 0o777).toBe(diskMode(0o555));
        await chmod(outside, 0o755);
        await chmod(join(config, 'skills'), 0o755);
        await chmod(join(config, 'skills', 'review'), 0o755);
    });

    test('a built invocation runs the task as its only stream-json input', async () => {
        const { root, workspace, workbench } = await project();
        const bin = await fakeClaude(root);
        const report = join(root, 'report.txt');
        const ready = await prepare(workbench);
        const { runtime } = fakeRuntime('local', {
            workbench,
            workspace,
            environment: {
                PATH: `${bin}${delimiter}${process.platform === 'win32' ? `${process.env.SystemRoot}\\System32` : '/usr/bin:/bin'}`,
                WORKBENCH_TEST_REPORT: report,
            },
        });
        const invocation = ready.build(
            runtime,
            'Review "the" diff',
            configuration('anthropic')
        );

        expect(flag(claudeArguments(invocation), '--permission-prompts')).toBe('none');
        expect(ready.publicInvocation(invocation)).toEqual({
            command: invocation.command,
            cwd: workspace,
            claude_config_directory: ready.assets[0]?.path,
        });
        await run(invocation);
        const input = (await readFile(report, 'utf8')).split('\ninput=')[1] ?? '';
        expect(JSON.parse(input)).toMatchObject({
            type: 'user',
            message: { role: 'user', content: 'Review "the" diff' },
        });
        // The route is a subscription, so the normalizer reports no spend.
        const usage = ready
            .events()
            .consume({ type: 'result', usage: { input_tokens: 1 }, total_cost_usd: 1 });
        expect(usage.events[0]?.data.cost_usd).toBe(0);
    });

    test('a built invocation carries a 300 KiB task in bounded arguments, never the environment', async () => {
        const { root, workspace, workbench } = await project();
        const bin = await fakeClaude(root);
        const report = join(root, 'report.txt');
        const ready = await prepare(workbench);
        const { runtime } = fakeRuntime('local', {
            workbench,
            workspace,
            environment: {
                PATH: `${bin}${delimiter}${process.platform === 'win32' ? `${process.env.SystemRoot}\\System32` : '/usr/bin:/bin'}`,
                WORKBENCH_TEST_REPORT: report,
            },
        });
        // Shell syntax, quotes, and characters outside the BMP must survive unchanged.
        const unit = 'Review $HOME `id` "quoted" \\n back\\slash 😀 é\n';
        const task = unit.repeat(Math.ceil((300 * 1024) / unit.length));
        const invocation = ready.build(runtime, task, configuration('anthropic'));

        const limit = 128 * 1024;
        for (const argument of invocation.command) {
            expect(Buffer.byteLength(argument)).toBeLessThan(limit);
        }
        for (const value of Object.values(invocation.env)) {
            expect(Buffer.byteLength(value ?? '')).toBeLessThan(limit);
            expect(value ?? '').not.toContain('Review $HOME');
        }
        await run(invocation);
        const input = (await readFile(report, 'utf8')).split('\ninput=')[1] ?? '';
        expect(JSON.parse(input).message.content).toBe(task.trim());
    });
});
