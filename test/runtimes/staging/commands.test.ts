import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
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
