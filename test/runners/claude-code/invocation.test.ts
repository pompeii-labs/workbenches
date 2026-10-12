import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    buildClaudeCodeInvocation,
    type ClaudeCodeInvocationOptions,
    inSessionConfig,
} from '../../../src/runners/claude-code/invocation.js';
import type { RunnerInvocation } from '../../../src/types.js';

const options: ClaudeCodeInvocationOptions = {
    workspaceDirectory: '/workspace',
    environment: {
        PATH: '/usr/bin',
        HOME: '/home/user',
        CLAUDECODE: '1',
        CLAUDE_CODE_USE_BEDROCK: '1',
        CLAUDE_CONFIG_DIR: '/home/user/.claude',
        ANTHROPIC_BASE_URL: 'https://inherited.invalid',
        ANTHROPIC_API_KEY: 'inherited-key',
        ANTHROPICISH: 'kept',
    },
    routeEnvironment: {
        ANTHROPIC_BASE_URL: 'https://openrouter.ai/api',
        ANTHROPIC_AUTH_TOKEN: 'route-token',
        ANTHROPIC_API_KEY: '',
    },
    model: 'claude-sonnet-4-5',
    paths: {
        configDirectory: '/staged/config',
        mcpConfigPath: '/staged/mcp.json',
        systemPromptPath: '/staged/system.md',
    },
    settings: '/staged/settings.json',
    answersPrompts: true,
    session: { id: '11111111-1111-4111-8111-111111111111', resume: false },
    secureStorageDirectory: '',
    scrubSubprocessEnvironment: true,
};

describe('Claude Code invocation', () => {
    test('runs one stream-json process with staged settings and the stdio prompt tool', () => {
        const invocation = buildClaudeCodeInvocation(options);
        expect(invocation.cwd).toBe('/workspace');
        expect(invocation.command).toEqual([
            'claude',
            '-p',
            '--input-format',
            'stream-json',
            '--output-format',
            'stream-json',
            '--verbose',
            '--replay-user-messages',
            '--model',
            'claude-sonnet-4-5',
            '--setting-sources',
            'user',
            '--settings',
            '/staged/settings.json',
            '--strict-mcp-config',
            '--mcp-config',
            '/staged/mcp.json',
            '--append-system-prompt-file',
            '/staged/system.md',
            '--system-prompt-snapshot',
            'off',
            '--permission-prompt-tool',
            'stdio',
            '--session-id',
            '11111111-1111-4111-8111-111111111111',
        ]);
    });

    test('denies prompts without an answerer, resumes, and limits turns when asked', () => {
        const command = buildClaudeCodeInvocation({
            ...options,
            answersPrompts: false,
            session: { id: 'native-session', resume: true },
            maxTurns: 12,
        }).command;
        expect(command.slice(-6)).toEqual([
            '--permission-prompts',
            'none',
            '--resume',
            'native-session',
            '--max-turns',
            '12',
        ]);
        expect(command).not.toContain('--permission-prompt-tool');
        expect(command).not.toContain('--session-id');
    });

    test('replaces inherited Claude and Anthropic settings with the route and isolation', () => {
        const env = buildClaudeCodeInvocation(options).env;
        expect(
            Object.fromEntries(
                Object.entries(env).filter(
                    ([name]) =>
                        name.startsWith('CLAUDE') || name.startsWith('ANTHROPIC')
                )
            )
        ).toEqual({
            ANTHROPIC_BASE_URL: 'https://openrouter.ai/api',
            ANTHROPIC_AUTH_TOKEN: 'route-token',
            ANTHROPIC_API_KEY: '',
            ANTHROPICISH: 'kept',
            CLAUDE_CONFIG_DIR: '/staged/config',
            CLAUDE_SECURESTORAGE_CONFIG_DIR: '',
            CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
            CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1',
        });
        expect(env.PATH).toBe('/usr/bin');
        expect(env.PWD).toBe('/workspace');
        expect(
            buildClaudeCodeInvocation({
                ...options,
                scrubSubprocessEnvironment: false,
                secureStorageDirectory: '/credentials',
            }).env
        ).toMatchObject({
            CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '0',
            CLAUDE_SECURESTORAGE_CONFIG_DIR: '/credentials',
        });
    });

    test('adds each directory outside the workspace with its own flag', () => {
        const command = buildClaudeCodeInvocation({
            ...options,
            settings: '{"permissions":{"allow":[],"deny":[]}}',
            additionalDirectories: ['/runs/r1/outbox', '/work/docs'],
        }).command;
        const at = command.indexOf('--add-dir');
        expect(command.slice(at, at + 4)).toEqual([
            '--add-dir',
            '/runs/r1/outbox',
            '--add-dir',
            '/work/docs',
        ]);
        expect(command[command.indexOf('--settings') + 1]).toBe(
            '{"permissions":{"allow":[],"deny":[]}}'
        );
    });

    test('refuses a session config directory that is a symlink', async () => {
        const root = await mkdtemp(join(tmpdir(), 'claude-config-link-'));
        try {
            const target = join(root, 'target');
            await mkdir(join(target, 'skills'), { recursive: true });
            await writeFile(join(target, 'skills', 'keep.txt'), 'keep');
            const link = join(root, 'link');
            await symlink(target, link);
            const wrapped = inSessionConfig(
                { command: ['true'], env: {} } as unknown as RunnerInvocation,
                join(root, 'staged')
            );
            const [shell, flag, script, ...rest] = wrapped.command;
            const result = Bun.spawnSync(
                [shell as string, flag as string, script as string, ...rest],
                {
                    env: { ...process.env, CLAUDE_CONFIG_DIR: link, ...wrapped.env },
                }
            );
            expect(result.exitCode).not.toBe(0);
            expect(result.stderr.toString()).toContain('symlink');
            expect(await readFile(join(target, 'skills', 'keep.txt'), 'utf8')).toBe(
                'keep'
            );
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    test('rejects an invalid turn limit', () => {
        for (const maxTurns of [0, -1, 1.5]) {
            expect(() => buildClaudeCodeInvocation({ ...options, maxTurns })).toThrow(
                'positive integer'
            );
        }
    });
});
