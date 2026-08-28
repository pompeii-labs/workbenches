import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    ConnectionStore,
    type RunnerConnectionContext,
} from '../src/connections/store.js';

const temporaryDirectories: string[] = [];
const context: RunnerConnectionContext = {
    reference: 'project-core',
    runner: 'pi',
    model: 'openai/gpt-5.6-terra',
    runtime: 'local',
};

afterEach(async () => {
    await Promise.all(
        temporaryDirectories
            .splice(0)
            .map((directory) => rm(directory, { recursive: true, force: true }))
    );
});

describe('runner connection preferences', () => {
    test('stores one non-secret selection per Workbench context', async () => {
        const home = await temporaryHome();
        const store = new ConnectionStore(home);
        await store.save(context, {
            provider: 'openai',
            nativeProvider: 'openai-codex',
        });
        await store.save(context, {
            provider: 'openrouter',
            nativeProvider: 'openrouter',
        });

        expect(await store.find(context)).toEqual({
            provider: 'openrouter',
            nativeProvider: 'openrouter',
        });
        expect(
            await store.find({ ...context, reference: 'other-core' })
        ).toBeUndefined();
        expect((await stat(join(home, 'connections.json'))).mode & 0o777).toBe(0o600);
        const stored = await readFile(join(home, 'connections.json'), 'utf8');
        expect(stored).not.toContain('token');
        expect(stored).not.toContain('key');
    });

    test('rejects malformed local state instead of guessing', async () => {
        const home = await temporaryHome();
        const store = new ConnectionStore(home);
        await writeFile(join(home, 'connections.json'), '{"version":1}', 'utf8');
        await expect(store.find(context)).rejects.toThrow('connection file is invalid');
    });
});

async function temporaryHome(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'workbench-connections-'));
    temporaryDirectories.push(directory);
    return directory;
}
