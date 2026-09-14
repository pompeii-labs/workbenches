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
    runner: 'pi',
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
    test('stores one non-secret selection per runner and runtime', async () => {
        const home = await temporaryHome();
        const store = new ConnectionStore(home);
        await store.save(context, {
            provider: 'openai',
            nativeProvider: 'openai-codex',
        });
        await store.save(context, {
            provider: 'openrouter',
            nativeProvider: 'openrouter',
            authenticationMethod: 'api',
        });

        expect(await store.find(context)).toEqual({
            provider: 'openrouter',
            nativeProvider: 'openrouter',
            authenticationMethod: 'api',
        });
        expect(await store.find({ runner: 'pi', runtime: 'e2b' })).toBeUndefined();
        expect((await stat(join(home, 'connections.json'))).mode & 0o777).toBe(0o600);
        const stored = await readFile(join(home, 'connections.json'), 'utf8');
        expect(JSON.parse(stored)).toMatchObject({
            version: 3,
            connections: [
                {
                    runner: 'pi',
                    runtime: 'local',
                    provider: 'openrouter',
                    native_provider: 'openrouter',
                    authentication_method: 'api',
                },
            ],
        });
        expect(stored).not.toContain('token');
        expect(stored).not.toContain('key');
    });

    test('migrates the newest Workbench-scoped preference for each boundary', async () => {
        const home = await temporaryHome();
        await writeFile(
            join(home, 'connections.json'),
            JSON.stringify({
                version: 1,
                connections: [
                    {
                        reference: 'older-core',
                        runner: 'opencode',
                        model: 'openai/gpt-old',
                        runtime: 'e2b',
                        provider: 'openrouter',
                        native_provider: 'openrouter',
                        updated_at: '2026-01-01T00:00:00.000Z',
                    },
                    {
                        reference: 'newer-core',
                        runner: 'opencode',
                        model: 'openai/gpt-new',
                        runtime: 'e2b',
                        provider: 'openai',
                        native_provider: 'openai',
                        updated_at: '2026-02-01T00:00:00.000Z',
                    },
                ],
            }),
            'utf8'
        );
        const store = new ConnectionStore(home);

        expect(await store.find({ runner: 'opencode', runtime: 'e2b' })).toEqual({
            provider: 'openai',
            nativeProvider: 'openai',
        });

        await store.save(
            { runner: 'opencode', runtime: 'e2b' },
            { provider: 'openai', nativeProvider: 'openai' }
        );
        expect(
            JSON.parse(await readFile(join(home, 'connections.json'), 'utf8'))
        ).toMatchObject({
            version: 3,
            connections: [{ runner: 'opencode', runtime: 'e2b' }],
        });
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
