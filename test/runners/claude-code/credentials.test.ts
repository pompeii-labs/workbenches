import { expect, test } from 'bun:test';

import { NativeCredentialFile } from '../../../src/connections/nativecredentials.js';
import {
    ClaudeCodeCredentialSettings,
    storedClaudeCodeEnvironment,
} from '../../../src/runners/claude-code/credentials.js';
import type { RuntimeCredentialFiles } from '../../../src/runtimes/contracts.js';

class Settings implements RuntimeCredentialFiles {
    constructor(public source: string | undefined) {}
    async read() {
        return this.source;
    }
    async write(_path: string, source: string) {
        this.source = source;
    }
}

test('Claude Code settings preserve other keys and settings when saving and removing a provider', async () => {
    const files = new Settings(
        JSON.stringify({
            env: { ANTHROPIC_API_KEY: 'fixture-anthropic', OTHER: 'fixture-other' },
            permissions: { deny: ['Bash'] },
        })
    );
    const file = NativeCredentialFile.for('claude-code');
    await file.save(files, 'openrouter', file.apiKey('fixture-openrouter'));
    expect(await file.find(files, 'anthropic')).toMatchObject({ type: 'api_key' });
    expect(await file.remove(files, 'openrouter')).toBeTrue();
    expect(await file.remove(files, 'openrouter')).toBeFalse();
    expect(JSON.parse(files.source ?? '{}')).toEqual({
        env: { ANTHROPIC_API_KEY: 'fixture-anthropic', OTHER: 'fixture-other' },
        permissions: { deny: ['Bash'] },
    });
    files.source = '{"env":42}';
    await expect(
        file.save(files, 'openrouter', file.apiKey('fixture-key'))
    ).rejects.toThrow('left unchanged');
    expect(files.source).toBe('{"env":42}');
    await expect(
        file.save(files, 'anthropic', {
            type: 'oauth',
            value: { refresh: 'fixture-token' },
        })
    ).rejects.toThrow('only API keys');
});

for (const name of ['e2b', 'daytona']) {
    test(`Claude Code reads only documented provider settings in ${name} and preserves environment precedence`, async () => {
        let reads = 0;
        const runtime = {
            name,
            environment: {
                WORKBENCH_CREDENTIALS_DIR: '/workbench-credentials',
                OPENROUTER_API_KEY: 'fixture-inherited',
                EMPTY: '',
            },
            workspaceDirectory: '/workspace',
            execute: async (invocation: { command: string[] }) => {
                reads++;
                expect(invocation.command.join(' ')).toContain(
                    '/workbench-credentials/claude-code/settings.json'
                );
                return {
                    code: 0,
                    stdout: JSON.stringify({
                        env: {
                            OPENROUTER_API_KEY: 'fixture-stored',
                            ANTHROPIC_API_KEY: 'fixture-anthropic',
                            CLAUDE_CODE_OAUTH_TOKEN: 'fixture-never-load',
                            OTHER: 'fixture-never-load',
                        },
                    }),
                    stderr: '',
                };
            },
        };
        expect(await storedClaudeCodeEnvironment(runtime)).toEqual({
            OPENROUTER_API_KEY: 'fixture-stored',
            ANTHROPIC_API_KEY: 'fixture-anthropic',
        });
        const settings = new ClaudeCodeCredentialSettings();
        expect(await settings.load(runtime)).toMatchObject({
            OPENROUTER_API_KEY: 'fixture-inherited',
            ANTHROPIC_API_KEY: 'fixture-anthropic',
            EMPTY: '',
        });
        expect(reads).toBe(2);
        expect(await settings.load({ ...runtime, environment: {} })).toEqual({});
        expect(await settings.load({ ...runtime, name: 'local' })).not.toHaveProperty(
            'ANTHROPIC_API_KEY'
        );
        expect(reads).toBe(2);
    });
}
