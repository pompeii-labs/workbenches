import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    OutcomeLifecycle,
    OutcomeStore,
    type RunOutcome,
} from '../../src/outcomes/index.js';
import type { PreparedRuntime } from '../../src/runtimes/contracts.js';

const directories: string[] = [];
afterEach(async () => {
    await Promise.all(
        directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
    );
});
async function fixture(onAvailable?: (outcome: RunOutcome) => Promise<void> | void) {
    const home = await mkdtemp(join(tmpdir(), 'workbench-live-results-'));
    directories.push(home);
    const lifecycle = await OutcomeLifecycle.create({
        home,
        runId: 'wb_1234567890abcdefghij',
        ...(onAvailable ? { onAvailable } : {}),
        now: () => new Date('2026-09-16T00:00:00.000Z'),
    });
    return {
        home,
        lifecycle,
        store: new OutcomeStore(home),
        file: join(lifecycle.output.directory, 'report.bin'),
    };
}

describe('live immutable outbox snapshots', () => {
    test('publishes exact durable revisions, suppresses unchanged output, and still collects a separate final outcome', async () => {
        const published: RunOutcome[] = [];
        const f = await fixture(async (outcome) => {
            expect(await f.store.read(outcome.id)).toEqual(outcome);
            expect((await f.store.receipt(outcome.id)).state).toBe('present');
            published.push(outcome);
        });
        expect(await f.lifecycle.checkpoint(undefined, 1)).toBeUndefined();
        expect(await f.store.list()).toEqual([]);
        const firstBytes = Buffer.from([0, 1, 255]);
        const secondBytes = Buffer.from([128, 0, 254, 7]);
        await writeFile(f.file, firstBytes);
        const first = await f.lifecycle.checkpoint(undefined, 2);
        if (!first?.artifacts[0]) throw new Error('Missing initial snapshot');
        const firstPath = await f.store.artifactPath(first.id, first.artifacts[0].id);
        expect(await f.lifecycle.checkpoint(undefined, 3)).toEqual(first);
        expect(published).toHaveLength(1);
        await writeFile(f.file, secondBytes);
        const second = await f.lifecycle.checkpoint(undefined, 4);
        if (!second?.artifacts[0]) throw new Error('Missing revised snapshot');
        expect(second.id).not.toBe(first.id);
        expect(first.turn_index).toBe(2);
        expect(second.turn_index).toBe(4);
        expect(second.completeness).toBe('partial');
        expect(second.changesets).toEqual([]);
        expect(await f.store.findFinalByRun(first.run_id)).toBeUndefined();
        expect(await readFile(firstPath)).toEqual(firstBytes);
        const secondPath = await f.store.artifactPath(
            second.id,
            second.artifacts[0].id
        );
        expect(await readFile(secondPath)).toEqual(secondBytes);
        const final = await f.lifecycle.collect(undefined, 'complete');
        expect(final?.turn_index).toBeUndefined();
        expect(final?.completeness).toBe('complete');
        expect(await f.store.findFinalByRun(first.run_id)).toEqual(final);
        expect(await f.store.findByRun(first.run_id)).toEqual(final);
        expect(await f.store.listByRun(first.run_id)).toHaveLength(3);
        await f.lifecycle.cleanup();
        expect(await readFile(firstPath)).toEqual(firstBytes);
        expect(await readFile(secondPath)).toEqual(secondBytes);
        await expect(f.lifecycle.checkpoint(undefined, 5)).rejects.toThrow(
            'final collection'
        );
    });

    test('retries publication without duplicating a snapshot', async () => {
        let attempts = 0;
        const f = await fixture(() => {
            if (++attempts === 1) throw new Error('Notification failed');
        });
        await writeFile(f.file, 'original');
        await expect(f.lifecycle.checkpoint(undefined, 1)).rejects.toThrow(
            'Notification failed'
        );
        expect(await f.store.list()).toHaveLength(1);
        const snapshot = await f.lifecycle.checkpoint(undefined, 2);
        expect(snapshot?.turn_index).toBe(1);
        expect(attempts).toBe(2);
        expect(await f.store.list()).toHaveLength(1);
    });

    test('uses the runtime outbox hook without collecting workspace diffs or finalizing the sandbox', async () => {
        const f = await fixture();
        let finalized = 0;
        let closed = 0;
        let collected = 0;
        let outputReads = 0;
        const runtime = {
            collectOutput: async () => {
                outputReads++;
                return { summary: 'Remote report', artifacts: [], links: [] };
            },
            collectOutcome: async () => {
                collected++;
                return {
                    application_state: 'pending',
                    changesets: [],
                    artifacts: [],
                    links: [],
                    warnings: [],
                };
            },
            finalizeOutcome: async () => {
                finalized++;
            },
            cleanup: async () => {
                closed++;
            },
        } as unknown as PreparedRuntime;
        const snapshot = await f.lifecycle.checkpoint(runtime, 1);
        await f.lifecycle.checkpoint(runtime, 2);
        expect(snapshot?.summary).toBe('Remote report');
        expect(outputReads).toBe(2);
        expect(collected).toBe(0);
        expect(finalized).toBe(0);
        expect(closed).toBe(0);
        const final = await f.lifecycle.collect(runtime, 'complete');
        expect((await f.store.receipt(final?.id ?? '')).state).toBe('pending');
        expect(collected).toBe(1);
        expect(finalized).toBe(1);
        expect(closed).toBe(0);
    });

    test('malformed metadata is visible and retryable, never an empty successful snapshot', async () => {
        const f = await fixture();
        await writeFile(join(f.lifecycle.output.directory, 'outcome.json'), '{');
        await expect(f.lifecycle.checkpoint(undefined, 1)).rejects.toThrow();
        expect(await f.store.list()).toEqual([]);
        await writeFile(
            join(f.lifecycle.output.directory, 'outcome.json'),
            JSON.stringify({
                version: 1,
                links: [
                    {
                        label: 'PR',
                        uri: 'https://example.com/pull/1',
                        kind: 'pull_request',
                    },
                ],
            })
        );
        expect((await f.lifecycle.checkpoint(undefined, 2))?.links[0]?.kind).toBe(
            'pull_request'
        );
    });

    test('serializes turn and final capture, and rejects invalid turn identities before writes', async () => {
        const f = await fixture();
        for (const index of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN]) {
            await expect(f.lifecycle.checkpoint(undefined, index)).rejects.toThrow(
                'positive safe integer'
            );
        }
        await writeFile(f.file, 'serialized');
        const snapshot = f.lifecycle.checkpoint(undefined, 1);
        const final = f.lifecycle.collect(undefined, 'complete');
        const [first, last] = await Promise.all([snapshot, final]);
        expect(first?.turn_index).toBe(1);
        expect(last?.turn_index).toBeUndefined();
        expect(await f.store.list()).toHaveLength(2);
    });
});
