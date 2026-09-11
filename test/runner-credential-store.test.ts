import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RunnerCredentialStore } from '../src/connections/credentials.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories
            .splice(0)
            .map((directory) => rm(directory, { recursive: true, force: true }))
    );
});

describe('runner credential storage', () => {
    test('creates a private deterministic directory without credential contents', async () => {
        const home = await mkdtemp(join(tmpdir(), 'workbench-credentials-'));
        temporaryDirectories.push(home);
        const store = new RunnerCredentialStore(home);

        const first = await store.prepare('E2B', 'OpenCode');
        const second = await store.prepare('e2b', 'opencode');

        expect(first).toEqual(second);
        expect(first).toEqual({
            runtime: 'e2b',
            runner: 'opencode',
            directory: join(home, 'runtime-credentials', 'e2b', 'opencode'),
        });
        expect((await stat(join(home, 'runtime-credentials'))).mode & 0o777).toBe(
            0o700
        );
        expect(
            (await stat(join(home, 'runtime-credentials', 'e2b'))).mode & 0o777
        ).toBe(0o700);
        expect((await stat(first.directory)).mode & 0o777).toBe(0o700);
    });

    test('rejects a runner name that could escape the credential root', () => {
        const store = new RunnerCredentialStore('/workbench-home');
        expect(() => store.binding('e2b', '../opencode')).toThrow(
            'Invalid runner credential store name'
        );
        expect(() => store.binding('../e2b', 'opencode')).toThrow(
            'Invalid runtime name'
        );
    });

    test('rejects symbolic links inside the credential path', async () => {
        const home = await mkdtemp(join(tmpdir(), 'workbench-credentials-'));
        const target = await mkdtemp(join(tmpdir(), 'workbench-credentials-target-'));
        temporaryDirectories.push(home, target);
        await mkdir(join(home, 'runtime-credentials'));
        await symlink(target, join(home, 'runtime-credentials', 'e2b'));

        await expect(
            new RunnerCredentialStore(home).prepare('e2b', 'opencode')
        ).rejects.toThrow('Runner credential storage must be a real directory');
    });
});
