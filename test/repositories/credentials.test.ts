import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('native GitHub credential transport', () => {
    test('Git invokes the configured gh credential helper without saving a token', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'workbench-gh-helper-'));
        try {
            await writeFile(
                join(directory, 'gh'),
                '#!/bin/sh\n[ "$1 $2" = "auth git-credential" ] || exit 2\nprintf "protocol=https\\nhost=github.com\\nusername=x-access-token\\npassword=fixture-token\\n"\n',
                { mode: 0o700 }
            );
            const child = Bun.spawn(['git', 'credential', 'fill'], {
                env: {
                    PATH: `${directory}:${process.env.PATH ?? ''}`,
                    GH_TOKEN: 'fixture-token',
                    GIT_CONFIG_GLOBAL: '/dev/null',
                    GIT_CONFIG_SYSTEM: '/dev/null',
                    GIT_CONFIG_NOSYSTEM: '1',
                    GIT_TERMINAL_PROMPT: '0',
                    GIT_CONFIG_COUNT: '2',
                    GIT_CONFIG_KEY_0: 'credential.https://github.com.helper',
                    GIT_CONFIG_VALUE_0: '',
                    GIT_CONFIG_KEY_1: 'credential.https://github.com.helper',
                    GIT_CONFIG_VALUE_1: '!gh auth git-credential',
                },
                stdin: 'pipe',
                stdout: 'pipe',
                stderr: 'pipe',
            });
            child.stdin.write('protocol=https\nhost=github.com\n\n');
            child.stdin.end();
            const [output, errors, code] = await Promise.all([
                new Response(child.stdout).text(),
                new Response(child.stderr).text(),
                child.exited,
            ]);
            expect({ code, errors }).toEqual({ code: 0, errors: '' });
            expect(output).toContain('username=x-access-token');
            expect(output).toContain('password=fixture-token');
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });
});
