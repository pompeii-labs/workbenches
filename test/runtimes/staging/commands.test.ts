import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
    mkdir,
    mkdtemp,
    readFile,
    rename,
    rm,
    symlink,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CollectionCommands } from '../../../src/runtimes/staging/commands.js';
import { TransferRules } from '../../../src/runtimes/staging/rules.js';

const commands = new CollectionCommands(new TransferRules('E2B'));
const directories: string[] = [];

afterEach(async () => {
    await Promise.all(
        directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
    );
});

async function shell(command: string, cwd: string): Promise<string> {
    const process = Bun.spawn(['sh', '-c', command], {
        cwd,
        stdout: 'pipe',
        stderr: 'pipe',
        env: {
            ...Bun.env,
            GIT_AUTHOR_NAME: 'Test',
            GIT_AUTHOR_EMAIL: 'test@example.com',
            GIT_COMMITTER_NAME: 'Test',
            GIT_COMMITTER_EMAIL: 'test@example.com',
        },
    });
    const [stdout, stderr, code] = await Promise.all([
        new Response(process.stdout).text(),
        new Response(process.stderr).text(),
        process.exited,
    ]);
    if (code !== 0) throw new Error(`${command} failed: ${stderr}`);
    return stdout;
}

const names = (value: string) => value.split('\0').filter(Boolean).toSorted();

describe('collection commands', () => {
    test('lists exact sizes and hashes without interpreting file names', async () => {
        const root = await mkdtemp(join(tmpdir(), 'workbench-output-commands-'));
        directories.push(root);
        await mkdir(join(root, 'nested'));
        const files = new Map([
            ['space name.txt', 'space'],
            ['line\nbreak.txt', 'newline'],
            ["-leading'quote.txt", 'dash'],
            ['nested/outcome.json', '{}'],
            ['empty', ''],
        ]);
        for (const [path, content] of files) await writeFile(join(root, path), content);
        await symlink('nested', join(root, 'link'));
        const [tool, ...fields] = (await shell(commands.remoteFiles(root), root)).split(
            '\0'
        );
        expect(['sha256sum', 'shasum']).toContain(tool ?? '');
        expect(fields.pop()).toBe('');
        const records = new Map<string, string[]>();
        for (let index = 0; index < fields.length; index += 4)
            records.set(fields[index + 1] ?? '', [
                fields[index] ?? '',
                fields[index + 2] ?? '',
                fields[index + 3] ?? '',
            ]);
        expect(records.size).toBe(files.size + 1);
        expect(records.get('link')).toEqual(['l', '', '']);
        for (const [path, content] of files) {
            const record = records.get(path);
            expect(record?.[0]).toBe('f');
            expect(Number(record?.[1])).toBe(Buffer.byteLength(content));
            expect(record?.[2]).toBe(
                createHash('sha256').update(content).digest('hex')
            );
        }
    });

    test('a renamed file is listed as its old path deleted and its new path changed', async () => {
        const parent = await mkdtemp(join(tmpdir(), 'workbench-commands-'));
        directories.push(parent);
        const root = join(parent, 'workspace');
        await mkdir(root);
        const body = `${Array.from({ length: 40 }, (_, line) => `line ${line}`).join('\n')}\n`;
        await writeFile(join(root, 'old.txt'), body);
        await writeFile(join(root, 'keep.txt'), 'keep\n');
        await shell(
            'git init -q && git add -A && git commit -q --no-gpg-sign -m baseline',
            root
        );
        const baseline = (await shell('git rev-parse HEAD', root)).trim();
        await rename(join(root, 'old.txt'), join(root, 'new.txt'));

        const out = {
            archive: join(parent, 'output.tar.gz'),
            changed: join(parent, 'changed'),
            deleted: join(parent, 'deleted'),
        };
        await shell(
            commands.workspace({ git: 'git', root, baseline, paths: out }),
            root
        );

        expect(names(await readFile(out.deleted, 'utf8'))).toEqual(['old.txt']);
        expect(names(await readFile(out.changed, 'utf8'))).toEqual(['new.txt']);
    });
});
