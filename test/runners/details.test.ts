import { describe, expect, test } from 'bun:test';

import {
    boundInput,
    boundOutput,
    boundPatch,
    byteLength,
    MAXIMUM_INPUT_BYTES,
    MAXIMUM_PATCH_BYTES,
} from '../../src/runners/bounds.js';
import { resultText, ToolDetails } from '../../src/runners/details.js';
import { patchFromUnified, unifiedDiff } from '../../src/runners/diff.js';
import { injectedSecrets } from '../../src/runners/secrets.js';

describe('unified diffs', () => {
    test('show a change with three lines of context and line counts', () => {
        const before = 'a\nb\nc\nd\ne\nf\ng\nh\n';
        const after = 'a\nb\nc\nd\nE\nf\ng\nh\ni\n';
        expect(unifiedDiff('src/x.txt', before, after)).toEqual({
            patch: '--- a/src/x.txt\n+++ b/src/x.txt\n@@ -2,7 +2,8 @@\n b\n c\n d\n-e\n+E\n f\n g\n h\n+i\n',
            additions: 2,
            deletions: 1,
        });
    });

    test('separate distant changes into hunks', () => {
        const lines = Array.from({ length: 20 }, (_, index) => `line ${index}\n`);
        const after = [...lines];
        after[1] = 'first\n';
        after[18] = 'last\n';
        const patch = unifiedDiff('x', lines.join(''), after.join('')).patch;
        expect(patch.match(/^@@/gmu)).toHaveLength(2);
        expect(patch).toContain('@@ -1,5 +1,5 @@\n line 0\n-line 1\n+first\n');
        expect(patch).toContain('@@ -16,5 +16,5 @@\n');
    });

    test('mark a last line without a newline and describe created and emptied files', () => {
        expect(unifiedDiff('x', 'one', 'one\n').patch).toBe(
            '--- a/x\n+++ b/x\n@@ -1,1 +1,1 @@\n-one\n\\ No newline at end of file\n+one\n'
        );
        expect(unifiedDiff('x', '', 'new\n').patch).toBe(
            '--- a/x\n+++ b/x\n@@ -0,0 +1,1 @@\n+new\n'
        );
        expect(unifiedDiff('x', 'old\n', '').patch).toBe(
            '--- a/x\n+++ b/x\n@@ -1,1 +0,0 @@\n-old\n'
        );
    });

    test("replace another tool's file headers and refuse a diff without hunks", () => {
        expect(
            patchFromUnified(
                'a.ts',
                'diff --git a/a.ts b/a.ts\nindex 1..2\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-x\n+y'
            )
        ).toEqual({
            patch: '--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-x\n+y\n',
            additions: 1,
            deletions: 1,
        });
        expect(
            patchFromUnified(
                'logo.png',
                'Binary files /dev/null and b/logo.png differ\n'
            )
        ).toBeUndefined();
    });
});

describe('detail bounds', () => {
    test('keep the first and last half of long output', () => {
        const text = `${'a'.repeat(9000)}${'é'.repeat(5000)}${'z'.repeat(9000)}`;
        const bounded = boundOutput(text);
        expect(bounded.truncated).toBe(true);
        expect(bounded.text.startsWith('a'.repeat(8192))).toBe(true);
        expect(bounded.text.endsWith(`\n${'z'.repeat(8192)}`)).toBe(true);
        expect(bounded.text).toContain(
            `\n…[${byteLength(text) - 2 * 8192} bytes truncated]…\n`
        );
        expect(boundOutput('short')).toEqual({ text: 'short', truncated: false });
    });

    test('cut the longest input strings first until the input fits', () => {
        const input = {
            path: '/workspace/a.txt',
            content: 'c'.repeat(30_000),
            nested: { lines: ['n'.repeat(12_000), 'kept'] },
        };
        const bounded = boundInput(input);
        expect(bounded.truncated).toBe(true);
        expect(byteLength(JSON.stringify(bounded.input))).toBeLessThanOrEqual(
            MAXIMUM_INPUT_BYTES
        );
        expect(bounded.input.path).toBe('/workspace/a.txt');
        expect(String(bounded.input.content)).toMatch(/^c+…\[\d+ bytes truncated\]$/u);
        expect(input.content).toHaveLength(30_000);
    });

    test('cut a long patch after the last whole hunk that fits', () => {
        const hunk = (index: number) =>
            `@@ -${index},1 +${index},1 @@\n-${'o'.repeat(20_000)}\n+${'n'.repeat(5_000)}\n`;
        const patch = `--- a/x\n+++ b/x\n${hunk(1)}${hunk(10)}${hunk(20)}${hunk(30)}`;
        const bounded = boundPatch(patch);
        expect(bounded.truncated).toBe(true);
        expect(bounded.patch).toBe(`--- a/x\n+++ b/x\n${hunk(1)}${hunk(10)}`);
        expect(byteLength(bounded.patch)).toBeLessThanOrEqual(MAXIMUM_PATCH_BYTES);
    });
});

describe('tool details', () => {
    test('redact secret-named arguments at any depth, in any spelling', () => {
        const details = new ToolDetails();
        expect(
            details.input('fetch', {
                url: 'https://user:pass@example.test/x',
                headers: { Authorization: 'Bearer abc', 'X-API-Key': 'k' },
                options: [{ clientSecret: 'value', password: 1 }],
                body: '{"token":"t1"}',
            })
        ).toEqual({
            input: {
                url: 'https://[REDACTED]@example.test/x',
                headers: { Authorization: '[REDACTED]', 'X-API-Key': '[REDACTED]' },
                options: [{ clientSecret: '[REDACTED]', password: '[REDACTED]' }],
                body: '{"token":[REDACTED]}',
            },
        });
    });

    test('apply every shell rule to a shell command and keep code assignments elsewhere', () => {
        const details = new ToolDetails();
        expect(details.input('bash', { command: 'FOO=bar ./run' }).input).toEqual({
            command: 'FOO=[REDACTED] ./run',
        });
        expect(details.input('write', { content: 'const x=1\n' }).input).toEqual({
            content: 'const x=1\n',
        });
    });

    test('redact exact injected values, longest first, from input, output, and patch', () => {
        const details = new ToolDetails({
            secrets: ['plain-value', 'plain-value-longer', 'abc'],
            workspace: '/workspace',
        });
        expect(
            details.input('read', { note: 'plain-value-longer and abc' }).input
        ).toEqual({ note: '[REDACTED] and abc' });
        expect(details.output('got plain-value')).toEqual({ output: 'got [REDACTED]' });
        expect(details.diff('/workspace/a', '', 'key plain-value\n').patch).toBe(
            '--- a/a\n+++ b/a\n@@ -0,0 +1,1 @@\n+key [REDACTED]\n'
        );
    });

    test('strip terminal control from output and take only text parts of a result', () => {
        const details = new ToolDetails();
        expect(details.output('\u001b[31mred\u001b[0m\r\nnext\u0007').output).toBe(
            'red\nnext'
        );
        expect(
            resultText([
                { type: 'text', text: 'one' },
                { type: 'image', data: 'BYTES' },
                { type: 'text', text: 'two' },
            ])
        ).toBe('one\ntwo');
        expect(resultText([{ type: 'image', data: 'BYTES' }])).toBeUndefined();
    });

    test('omit the patch of a binary file and diff a later write against an earlier one', () => {
        const details = new ToolDetails({ workspace: '/workspace' });
        expect(details.diff('/workspace/x.bin', '', 'a\u0000b')).toEqual({});
        expect(details.written('/workspace/a', 'one\n')).toEqual({});
        expect(details.written('/workspace/a', 'two\n').patch).toBe(
            '--- a/a\n+++ b/a\n@@ -1,1 +1,1 @@\n-one\n+two\n'
        );
        expect(details.relative('/elsewhere/b')).toBe('elsewhere/b');
    });

    test('select the declared and credential-named values of a run environment', () => {
        expect(
            injectedSecrets(
                {
                    DEPLOY_TARGET: 'staging-east',
                    OPENAI_API_KEY: 'sk-value',
                    GH_ENTERPRISE_TOKEN: 'abc',
                    PATH: '/usr/bin',
                },
                ['DEPLOY_TARGET']
            )
        ).toEqual(['staging-east', 'sk-value']);
    });
});
