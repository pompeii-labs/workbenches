import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { renderDiff } from '../../../src/runtimes/staging/diff.js';

const encode = (value: string) => new TextEncoder().encode(value);
const side = (value: string, mode = 0o644) => ({ mode, content: encode(value) });

/** What `git diff --no-index` prints for one file, minus the index line. */
async function gitDiff(before: string | undefined, after: string | undefined) {
    const directory = await mkdtemp(join(tmpdir(), 'workbench-diff-'));
    try {
        for (const [name, value] of [
            ['before', before],
            ['after', after],
        ] as const) {
            await mkdir(join(directory, name), { recursive: true });
            if (value !== undefined) {
                await mkdir(dirname(join(directory, name, 'f.txt')), {
                    recursive: true,
                });
                await writeFile(join(directory, name, 'f.txt'), value);
            }
        }
        const child = Bun.spawn(
            ['git', 'diff', '--no-index', '--no-renames', '--', 'before', 'after'],
            { cwd: directory, stdout: 'pipe', stderr: 'pipe' }
        );
        const output = await new Response(child.stdout).text();
        await child.exited;
        return (
            output
                .split('\n')
                .filter((line) => !line.startsWith('index '))
                .join('\n')
                .replaceAll('a/before/', 'a/')
                .replaceAll('b/after/', 'b/')
                // Git names both sides after the directory that holds the file.
                .replaceAll('a/after/', 'a/')
                .replaceAll('b/before/', 'b/')
                .replaceAll('a/before', 'a')
                .replaceAll('b/after', 'b')
        );
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

const numbered = (
    count: number,
    edit: (line: number) => string | undefined = () => undefined
) =>
    Array.from({ length: count }, (_, index) => edit(index + 1) ?? `line ${index + 1}`)
        .join('\n')
        .concat('\n');

describe('unified diff', () => {
    const cases: Array<[string, string | undefined, string | undefined]> = [
        ['an added file', undefined, 'one\ntwo\n'],
        ['a deleted file', 'one\ntwo\n', undefined],
        ['a changed line', 'one\ntwo\nthree\n', 'one\nTWO\nthree\n'],
        [
            'an insertion',
            numbered(10),
            numbered(10, (line) => (line === 5 ? 'inserted\nline 5' : undefined)),
        ],
        [
            'two distant edits',
            numbered(40),
            numbered(40, (line) =>
                line === 3 || line === 37 ? `edited ${line}` : undefined
            ),
        ],
        [
            'two near edits in one hunk',
            numbered(20),
            numbered(20, (line) =>
                line === 8 || line === 12 ? `edited ${line}` : undefined
            ),
        ],
        ['a missing final newline', 'one\ntwo', 'one\ntwo\n'],
        ['a dropped final newline', 'one\ntwo\n', 'one\ntwo'],
        ['emptying a file', 'one\n', ''],
        ['filling an empty file', '', 'one\n'],
        [
            'a removed block',
            numbered(30),
            numbered(30, (line) => (line >= 10 && line <= 14 ? '' : undefined)).replace(
                /\n{2,}/g,
                '\n'
            ),
        ],
    ];
    for (const [name, before, after] of cases) {
        test(`matches git for ${name}`, async () => {
            const mine = renderDiff(
                'f.txt',
                before === undefined ? undefined : side(before),
                after === undefined ? undefined : side(after)
            );
            const expected = await gitDiff(before, after);
            expect(mine).toBe(expected);
        });
    }

    test('reports a mode-only change', () => {
        expect(renderDiff('run.sh', side('x\n', 0o644), side('x\n', 0o755))).toBe(
            'diff --git a/run.sh b/run.sh\nold mode 100644\nnew mode 100755\n'
        );
    });

    test('reports no change as nothing', () => {
        expect(renderDiff('same.txt', side('x\n'), side('x\n'))).toBe('');
    });

    test('names a binary change without a patch', () => {
        const binary = { mode: 0o644, content: new Uint8Array([1, 0, 2]) };
        expect(renderDiff('logo.png', undefined, binary)).toContain(
            'Binary files /dev/null and b/logo.png differ'
        );
    });

    test('diffs symlink targets with the link mode', () => {
        const link = (target: string) => ({
            mode: 0o777,
            content: encode(target),
            symlink: true,
        });
        const output = renderDiff('alias', link('old'), link('new'));
        expect(output).toContain('-old');
        expect(output).toContain('+new');
        expect(output).toContain('\\ No newline at end of file');
    });

    test('replaces a file that differs past the edit budget', () => {
        const before = Array.from({ length: 4_000 }, (_, index) => `a${index}`).join(
            '\n'
        );
        const after = Array.from({ length: 4_000 }, (_, index) => `b${index}`).join(
            '\n'
        );
        const output = renderDiff('big.txt', side(before), side(after));
        expect(output).toContain('@@ -1,4000 +1,4000 @@');
    });
});
