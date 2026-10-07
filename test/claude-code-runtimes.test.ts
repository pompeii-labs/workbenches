import { describe, expect, test } from 'bun:test';

import { ClaudeCodeConfigStaging } from '../src/runners/claude-code/config.js';
import { ClaudeCodeRunner } from '../src/runners/claude-code/runner.js';
import { RunnerContextStaging } from '../src/runners/context/stage.js';
import { MemoryRunnerFiles } from '../src/runners/files/memory.js';
import type { PreparedRunner } from '../src/runners/runner.js';
import type { RunnerSessionHost } from '../src/runners/session.js';
import type {
    PreparedRuntime,
    RuntimeSessionOptions,
} from '../src/runtimes/contracts.js';
import type { RunnerInvocation, SpawnedRunner } from '../src/types.js';
import { modelCatalogFixture } from './model-catalog-fixture.js';
import {
    claudeCodeConfiguration,
    claudeCodeWorkbench,
    FakeClaudeCode,
} from './runners/claude-code/fixture.js';

const runtimeNames = ['docker', 'e2b', 'daytona'] as const;

describe('Claude Code remote runtimes', () => {
    for (const runtimeName of runtimeNames) {
        test(`${runtimeName} prepares config, runs sessions, resumes, and cancels`, async () => {
            const fixture = await runtimeFixture(runtimeName);
            const oneShot = await fixture.start(false);
            await expect(oneShot.session.prompt('one shot')).resolves.toEqual({
                reason: 'end_turn',
            });
            expect(fixture.native.invocations[0]?.command).toContain(
                '--permission-prompts'
            );
            await oneShot.session.close();

            fixture.native.scenario = 'permission_allow';
            const detached = await fixture.start(true);
            await expect(detached.session.prompt('permission turn')).resolves.toEqual({
                reason: 'end_turn',
            });
            expect(fixture.permissionRequests).toHaveLength(1);
            expect(fixture.native.invocations.at(-1)?.command).toContain(
                '--permission-prompt-tool'
            );
            expect(fixture.native.invocations.at(-1)?.env).toMatchObject({
                ANTHROPIC_API_KEY: 'anthropic-secret',
                CLAUDE_CONFIG_DIR: '/runtime-state/claude-code-config',
                CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: runtimeName === 'docker' ? '1' : '0',
            });
            expect(
                fixture.native.invocations.at(-1)?.env.CLAUDE_CODE_OAUTH_TOKEN
            ).toBeUndefined();
            const serialized = JSON.stringify(fixture.native.invocations.at(-1));
            expect(serialized).not.toContain('host-claude-value');
            expect(serialized).not.toContain('host-anthropic-value');
            await detached.session.close();

            fixture.native.scenario = 'steering';
            const steered = await fixture.start(true, 'claude-runtime-session');
            const active = steered.session.prompt('steering turn');
            if (runtimeName === 'docker') {
                await expect(steered.session.steer?.('focus')).resolves.toBeDefined();
                await steered.session.cancelTurn();
                await active;
            } else {
                await expect(steered.session.steer?.('focus')).rejects.toMatchObject({
                    code: 'capability_unsupported',
                    message: expect.stringContaining('steering is not supported'),
                });
                await steered.session.cancelTurn();
                await active;
            }
            await steered.session.close();

            fixture.files.file(
                '/session/claude-code-config/projects/workspace/native.jsonl',
                'native transcript\n'
            );
            fixture.native.scenario = 'multi_turn';
            const resumed = await fixture.start(true, 'claude-runtime-session');
            await resumed.session.prompt('resume turn');
            expect(fixture.native.invocations.at(-1)?.command).toContain('--resume');
            expect(
                fixture.files.text(
                    '/session/claude-code-config/projects/workspace/native.jsonl'
                )
            ).toBe('native transcript\n');
            await resumed.session.close();

            fixture.native.scenario = 'cancellation';
            const cancelled = await fixture.start(true, 'claude-runtime-session');
            const turn = cancelled.session.prompt('cancel turn');
            await cancelled.session.cancelTurn();
            await expect(turn).resolves.toEqual({ reason: 'cancelled' });
            expect(fixture.native.invocations.at(-1)?.killed).toBeFalse();
            await cancelled.session.close();
            await fixture.cleanup();
        });
    }

    test('removes temporary config after runtime configuration', async () => {
        const files = new MemoryRunnerFiles()
            .file('/workspace/CLAUDE.md', '# Runtime instructions\n')
            .file('/package/instructions.md', '# Instructions\n')
            .file('/package/skills/review/SKILL.md', '# Review\n')
            .file('/package/runner.json', '{}');
        const workbench = claudeCodeWorkbench();
        const runner = new ClaudeCodeRunner(
            new ClaudeCodeConfigStaging(files, new RunnerContextStaging(files)),
            modelCatalogFixture
        );
        const prepared = await runner.prepare(workbench, {});
        const directory = prepared.assets[0]?.path;
        if (!directory) throw new Error('Expected temporary Claude config');

        await prepared.configureRuntime?.(
            fakeRuntime('e2b', workbench, new FakeClaudeCode())
        );
        await prepared.cleanup();

        expect(files.paths().some((path) => path.startsWith(directory))).toBeFalse();
    });

    test('loads repository instructions from the selected workspace', async () => {
        const files = new MemoryRunnerFiles()
            .file('/workspace/CLAUDE.md', '# Workbench repository\n')
            .file('/selected/CLAUDE.md', '# Selected workspace\n')
            .file('/package/instructions.md', '# Instructions\n')
            .file('/package/skills/review/SKILL.md', '# Review\n')
            .file('/package/runner.json', '{}');
        await files.mkdir('/session', { recursive: true });
        const workbench = claudeCodeWorkbench();
        const runner = new ClaudeCodeRunner(
            new ClaudeCodeConfigStaging(files, new RunnerContextStaging(files)),
            modelCatalogFixture
        );
        const prepared = await runner.prepare(
            workbench,
            {},
            {
                workspaceDirectory: '/selected',
                session: {
                    id: 'wb_claudeselectedworkspace1',
                    directory: '/session',
                },
            }
        );

        await prepared.configureRuntime?.(
            fakeRuntime('e2b', workbench, new FakeClaudeCode())
        );

        const instructions = files.text(
            '/session/claude-code-config/.workbench-context/system.md'
        );
        expect(instructions).toContain('# Selected workspace');
        expect(instructions).not.toContain('# Workbench repository');
        await prepared.cleanup();
    });

    test('does not forward or bill an Anthropic key for a subscription', async () => {
        const fixture = await runtimeFixture('docker');
        const subscription = await fixture.start(false, undefined, 'oauth');

        await subscription.session.prompt('subscription turn');

        expect(fixture.native.invocations.at(-1)?.env).not.toHaveProperty(
            'ANTHROPIC_API_KEY'
        );
        await subscription.session.close();
        await fixture.cleanup();
    });
});

async function runtimeFixture(runtimeName: (typeof runtimeNames)[number]) {
    const files = new MemoryRunnerFiles()
        .file('/workspace/CLAUDE.md', '# Runtime instructions\n')
        .file('/package/instructions.md', '# Instructions\n')
        .file('/package/skills/review/SKILL.md', '# Review\n')
        .file('/package/runner.json', '{}');
    await files.mkdir('/session', { recursive: true });
    const workbench = claudeCodeWorkbench();
    workbench.manifest.runtimes =
        runtimeName === 'daytona'
            ? { daytona: { class: 'linux', image: 'fixture' } }
            : { [runtimeName]: { image: 'fixture' } };
    workbench.selectedRuntime = runtimeName;
    const runner = new ClaudeCodeRunner(
        new ClaudeCodeConfigStaging(files, new RunnerContextStaging(files)),
        modelCatalogFixture
    );
    const native = new FakeClaudeCode();
    const permissionRequests: string[] = [];
    const host: RunnerSessionHost = {
        emit: () => Promise.resolve(),
        requestPermission: async (request) => {
            permissionRequests.push(request.id);
            return 'allow_once';
        },
        requestQuestion: async () => ({ outcome: 'rejected' }),
    };
    const prepared: PreparedRunner[] = [];
    const start = async (
        answerRequests: boolean,
        nativeSessionId?: string,
        authenticationMethod?: string
    ) => {
        const sessionContext = {
            id: 'wb_clauderuntimefixture1',
            directory: '/session',
            ...(nativeSessionId ? { nativeSessionId } : {}),
        };
        const current = await runner.prepare(
            workbench,
            {
                ANTHROPIC_API_KEY: 'anthropic-secret',
                CLAUDE_CODE_OAUTH_TOKEN: 'oauth-secret',
            },
            { session: sessionContext }
        );
        prepared.push(current);
        const runtime = fakeRuntime(runtimeName, workbench, native);
        await current.configureRuntime?.(runtime);
        return {
            session: await current.startSession(runtime, {
                configuration: {
                    ...claudeCodeConfiguration(workbench),
                    ...(authenticationMethod ? { authenticationMethod } : {}),
                },
                host,
                answerRequests,
                session: {
                    ...sessionContext,
                    directory: '/runtime-state',
                },
            }),
        };
    };
    return {
        files,
        native,
        permissionRequests,
        start,
        cleanup: async () => {
            for (const current of prepared) await current.cleanup();
        },
    };
}

function fakeRuntime(
    name: string,
    workbench: ReturnType<typeof claudeCodeWorkbench>,
    native: FakeClaudeCode
): PreparedRuntime {
    const environment = {
        HOME: '/tmp/workbench-home',
        WORKBENCH_OUTPUT_DIR: '/outbox',
        ANTHROPIC_API_KEY: 'anthropic-secret',
        CLAUDE_CODE_OAUTH_TOKEN: 'oauth-secret',
        CLAUDE_HOST_VALUE: 'host-claude-value',
        ANTHROPIC_HOST_VALUE: 'host-anthropic-value',
    };
    return {
        name,
        workbench,
        workspaceDirectory: '/workspace',
        environment,
        workspaces: [],
        nativeAuthentication: 'unavailable',
        subprocessEnvironmentScrubbing: name === 'docker',
        pathFor: (path) => {
            if (path === '/session' || path.startsWith('/session/')) {
                return path.replace('/session', '/runtime-state');
            }
            if (path.startsWith('/tmp/workbench-claude-')) {
                return path.replace(
                    /^\/tmp\/workbench-claude-[^/]*/,
                    '/runtime-assets/2'
                );
            }
            throw new Error(`Path is not staged in ${name} runtime: ${path}`);
        },
        preflight: () => Promise.reject(new Error('not used')),
        execute: () => Promise.reject(new Error('not used')),
        interact: () => Promise.reject(new Error('not used')),
        launch: (invocation) => native.spawn(invocation),
        launchSession: (
            invocation: RunnerInvocation,
            _options: RuntimeSessionOptions
        ): SpawnedRunner => native.spawn(invocation),
        launchService: () => {
            throw new Error('not used');
        },
        cancel: (process) => process.kill?.(),
        cleanup: () => Promise.resolve(),
    };
}
