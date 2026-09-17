import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    OutcomeLifecycle,
    OutcomeOutput,
    OutcomeStore,
} from '../src/outcomes/index.js';
import type { PreparedRuntime } from '../src/runtimes/contracts.js';

const directories: string[] = [];
const lifecycles: OutcomeLifecycle[] = [];
afterEach(async () => {
    await Promise.all(lifecycles.splice(0).map((value) => value.cleanup()));
    await Promise.all(
        directories
            .splice(0)
            .map((value) => rm(value, { recursive: true, force: true }))
    );
});
async function home(): Promise<string> {
    const value = await mkdtemp(join(tmpdir(), 'workbench-lifecycle-'));
    directories.push(value);
    return value;
}

describe('OutcomeLifecycle', () => {
    test('durably collects exact artifact bytes, metadata and links before publication', async () => {
        const directory = await home();
        const available: string[] = [];
        const lifecycle = await OutcomeLifecycle.create({
            home: directory,
            runId: 'wb_1234567890abcdefghij',
            onAvailable: async (outcome, state) => {
                const store = new OutcomeStore(directory);
                expect(await store.read(outcome.id)).toEqual(outcome);
                expect((await store.receipt(outcome.id)).state).toBe(state);
                available.push(outcome.id);
            },
        });
        lifecycles.push(lifecycle);
        const bytes = Buffer.from([0, 12, 123, 255]);
        await writeFile(join(lifecycle.output.directory, 'original.png'), bytes);
        await writeFile(
            join(lifecycle.output.directory, 'outcome.json'),
            JSON.stringify({
                version: 1,
                summary: 'Result ready',
                links: [
                    {
                        label: 'Pull request',
                        uri: 'https://example.com/pull/1',
                        kind: 'pull_request',
                    },
                ],
            })
        );
        const outcome = await lifecycle.collect(undefined, 'partial');
        if (!outcome) throw new Error('Expected durable partial outcome');
        expect(outcome?.completeness).toBe('partial');
        expect(outcome?.summary).toBe('Result ready');
        expect(available).toEqual([outcome.id]);
        expect((await lifecycle.collect(undefined, 'complete'))?.id).toBe(outcome.id);
        expect(available).toHaveLength(1);
        await lifecycle.cleanup();
        const artifact = outcome.artifacts[0];
        if (!artifact) throw new Error('Expected original artifact');
        const content = artifact.content;
        expect(await readFile(await new OutcomeStore(directory).blob(content))).toEqual(
            bytes
        );
    });

    test('retries publication without recollecting or duplicating the immutable outcome', async () => {
        const directory = await home();
        let attempts = 0;
        const lifecycle = await OutcomeLifecycle.create({
            home: directory,
            runId: 'wb_1234567890abcdefghij',
            onAvailable: () => {
                attempts += 1;
                if (attempts === 1) throw new Error('Notification failed');
            },
        });
        lifecycles.push(lifecycle);
        await expect(lifecycle.collect(undefined, 'complete')).rejects.toThrow(
            'Notification failed'
        );
        const outcome = await lifecycle.collect(undefined, 'complete');
        expect(attempts).toBe(2);
        expect(await new OutcomeStore(directory).list()).toHaveLength(1);
        expect(outcome?.id).toBeString();
    });

    test('failed runtime collection is retryable, not replaced by an empty outcome', async () => {
        const directory = await home();
        let attempts = 0;
        const lifecycle = await OutcomeLifecycle.create({
            home: directory,
            runId: 'wb_1234567890abcdefghij',
        });
        lifecycles.push(lifecycle);
        const runtime = {
            collectOutcome: async () => {
                attempts += 1;
                if (attempts === 1) throw new Error('Transfer interrupted');
                return {
                    application_state: 'pending',
                    changesets: [],
                    artifacts: [],
                    links: [],
                    warnings: [],
                };
            },
        } as unknown as PreparedRuntime;
        await expect(lifecycle.collect(runtime, 'partial')).rejects.toThrow(
            'Transfer interrupted'
        );
        expect(await new OutcomeStore(directory).list()).toHaveLength(0);
        expect((await lifecycle.collect(runtime, 'partial'))?.completeness).toBe(
            'partial'
        );
        expect(attempts).toBe(2);
    });

    test('opening a caller-owned output directory does not authorize its deletion', async () => {
        const directory = await home();
        await writeFile(join(directory, 'keep.txt'), 'keep');
        await OutcomeOutput.open(directory).cleanup();
        expect((await stat(join(directory, 'keep.txt'))).isFile()).toBe(true);
    });
});
