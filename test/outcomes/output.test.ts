import { afterEach, describe, expect, test } from 'bun:test';
import {
    lstat,
    mkdir,
    mkdtemp,
    readFile,
    realpath,
    rm,
    symlink,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { OutcomeOutput, OutcomeStore } from '../../src/outcomes/index.js';
import { RunStore } from '../../src/runs/store.js';

const outputs: OutcomeOutput[] = [];
const directories: string[] = [];

afterEach(async () => {
    await Promise.all(outputs.splice(0).map((output) => output.cleanup()));
    await Promise.all(
        directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
    );
});

async function home(): Promise<string> {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'outbox-test-')));
    directories.push(directory);
    return directory;
}

async function output(
    directory?: string,
    runId = RunStore.createId()
): Promise<OutcomeOutput> {
    const created = await OutcomeOutput.create(directory ?? (await home()), runId);
    outputs.push(created);
    return created;
}

describe('OutcomeOutput', () => {
    test('owns a private canonical outbox per attempt and removes only that outbox', async () => {
        const directory = await home();
        const firstId = RunStore.createId();
        const first = await output(directory, firstId);
        const second = await output(directory);
        expect(first.directory).toBe(join(directory, 'runs', firstId, 'outbox'));
        expect(first.directory).not.toBe(second.directory);
        expect(first.directory).toBe(await realpath(first.directory));
        expect((await lstat(first.directory)).mode & 0o777).toBe(0o700);
        expect((await lstat(dirname(first.directory))).mode & 0o777).toBe(0o700);
        const metadata = join(dirname(first.directory), 'run.json');
        await writeFile(metadata, 'retained run metadata');
        await first.cleanup();
        await expect(lstat(first.directory)).rejects.toThrow();
        expect(await readFile(metadata, 'utf8')).toBe('retained run metadata');
        expect((await lstat(second.directory)).isDirectory()).toBeTrue();
        await first.cleanup();
    });

    test('rejects invalid run IDs before creating run storage', async () => {
        const directory = await home();
        for (const runId of ['../other', 'wb_../../other', '', '/outbox']) {
            await expect(OutcomeOutput.create(directory, runId)).rejects.toThrow(
                'Outcome run ID'
            );
        }
        await expect(lstat(join(directory, 'runs'))).rejects.toThrow();
    });

    test('does not replace or delete an existing outbox for the same run', async () => {
        const directory = await home();
        const runId = RunStore.createId();
        const created = await output(directory, runId);
        const artifact = join(created.directory, 'keep.txt');
        await writeFile(artifact, 'existing deliverable');
        await expect(OutcomeOutput.create(directory, runId)).rejects.toMatchObject({
            code: 'EEXIST',
        });
        expect(await readFile(artifact, 'utf8')).toBe('existing deliverable');
    });

    test('rejects symlinked run storage without touching its target', async () => {
        const directory = await home();
        const target = await home();
        await symlink(target, join(directory, 'runs'));
        await expect(
            OutcomeOutput.create(directory, RunStore.createId())
        ).rejects.toThrow('real directories');
        expect((await lstat(target)).isDirectory()).toBeTrue();
    });

    test('collects every output file and applies optional metadata', async () => {
        const created = await output();
        await mkdir(join(created.directory, 'reports'));
        await writeFile(
            join(created.directory, 'reports', 'summary.html'),
            '<h1>Hi</h1>'
        );
        await writeFile(join(created.directory, 'raw.txt'), 'raw\n');
        await writeFile(
            join(created.directory, 'outcome.json'),
            JSON.stringify({
                version: 1,
                summary: 'Finished the research.',
                artifacts: [
                    {
                        path: 'reports/summary.html',
                        name: 'Research summary',
                        description: 'The final report.',
                    },
                ],
                links: [
                    {
                        label: 'Preview',
                        uri: 'https://example.com/result',
                        kind: 'preview',
                    },
                ],
            })
        );
        const collected = await created.collect(new OutcomeStore(created.directory));
        expect(collected.summary).toBe('Finished the research.');
        expect(collected.artifacts.map((artifact) => artifact.name)).toEqual([
            'raw.txt',
            'Research summary',
        ]);
        expect(collected.artifacts[1]?.content.media_type).toBe('text/html');
        expect(collected.artifacts.map((artifact) => artifact.path)).toEqual([
            'raw.txt',
            'reports/summary.html',
        ]);
        expect(collected.links).toEqual([
            {
                id: 'link_preview_1',
                label: 'Preview',
                uri: 'https://example.com/result',
                kind: 'preview',
            },
        ]);
    });

    test('rejects declarations for missing files and output symlinks', async () => {
        const missing = await output();
        await writeFile(
            join(missing.directory, 'outcome.json'),
            JSON.stringify({
                version: 1,
                artifacts: [{ path: 'missing.txt' }],
            })
        );
        await expect(
            missing.collect(new OutcomeStore(missing.directory))
        ).rejects.toThrow('does not exist');

        const linked = await output();
        await writeFile(join(linked.directory, 'source.txt'), 'source');
        await symlink('source.txt', join(linked.directory, 'linked.txt'));
        await expect(
            linked.collect(new OutcomeStore(linked.directory))
        ).rejects.toThrow('cannot be symlinks');
    });

    test('rejects invalid declarations', async () => {
        const created = await output();
        await writeFile(join(created.directory, 'outcome.json'), '{nope');
        await expect(
            created.collect(new OutcomeStore(created.directory))
        ).rejects.toThrow('not valid JSON');
    });
});
