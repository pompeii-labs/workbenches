import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OutcomeStore } from '../src/outcomes/store.js';
import { RunStore } from '../src/runs/store.js';
import type {
    E2BClient,
    E2BManagedSandbox,
    E2BSandbox,
} from '../src/runtimes/e2b/contracts.js';
import { E2BOutcomeRecovery } from '../src/runtimes/e2b/recovery.js';
import {
    type E2BRecoveryRecord,
    parseE2BRecoveryRecord,
} from '../src/runtimes/e2b/recovery-record.js';
import { SessionRetention } from '../src/sessions/retention.js';

const directories: string[] = [];
afterEach(async () => {
    await Promise.all(
        directories
            .splice(0)
            .map((directory) => rm(directory, { recursive: true, force: true }))
    );
});

async function fixture() {
    const home = await mkdtemp(join(tmpdir(), 'workbench-recovery-test-'));
    directories.push(home);
    const runs = new RunStore(home);
    const run = await runs.create({
        metadata: {
            workbench: 'fixture',
            workbench_version: '0.1.0',
            runner: 'pi',
            model: 'openai/gpt-test',
            runtime: 'e2b',
            workspace: home,
        },
        request: {
            workbench_path: '/fixture',
            workspace: home,
            task: 'Recovery safety',
        },
    });
    await runs.update(run.id, { status: 'failed' });
    const identity = { id: run.id, scope: RunStore.scope(home) };
    const recovery = new E2BOutcomeRecovery(home, identity);
    const killed: string[] = [];
    let lists = 0;
    let connects = 0;
    let killFailure = false;
    let managed: E2BManagedSandbox[] = [
        { id: 'sandbox-original', runId: run.id, state: 'paused' },
    ];
    const sandbox: E2BSandbox = {
        id: 'sandbox-original',
        run: async () => ({ code: 0, stdout: '', stderr: '' }),
        start: async () => {
            throw new Error('No model work is permitted');
        },
        startPty: async () => {
            throw new Error('No authentication work is permitted');
        },
        upload: async () => {
            throw new Error('Unexpected upload');
        },
        download: async () => {
            throw new Error('Unexpected download');
        },
        fileSize: async () => 0,
        info: async () => {
            throw new Error('Unexpected info request');
        },
        host: () => '',
        pause: async () => {},
        kill: async () => {
            killed.push('sandbox-original');
        },
    };
    const client: E2BClient = {
        prepareTemplate: async () => {
            throw new Error('Recovery must not build templates');
        },
        createSandbox: async () => {
            throw new Error('Recovery must not create replacement sandboxes');
        },
        listManaged: async (scope) => {
            expect(scope).toBe(identity.scope);
            lists += 1;
            return managed;
        },
        killSandbox: async (id) => {
            if (killFailure) throw new Error('Cloud deletion failed');
            killed.push(id);
        },
        connectSandbox: async () => {
            connects += 1;
            throw new Error('Already committed work must not reconnect');
        },
    };
    await recovery.prepare();
    await recovery.checkpoint(sandbox, [], new Map(), 1_024);
    return {
        home,
        runs,
        run,
        identity,
        recovery,
        sandbox,
        client,
        killed,
        counts: () => ({ lists, connects }),
        setManaged: (values: E2BManagedSandbox[]) => {
            managed = values;
        },
        failKill: () => {
            killFailure = true;
        },
    };
}

describe('E2B outcome recovery safety', () => {
    test('an outbox snapshot never substitutes for final recovery or authorizes destroying unrecovered work', async () => {
        const f = await fixture();
        await f.recovery.retain(f.sandbox, new Set());
        const store = new OutcomeStore(f.home);
        const checkpoint = await store.commit(
            {
                version: 1,
                id: OutcomeStore.createId(),
                run_id: f.run.id,
                created_at: new Date().toISOString(),
                completeness: 'partial',
                turn_index: 1,
                summary: 'Earlier attachment',
                changesets: [],
                artifacts: [],
                links: [],
                warnings: [],
            },
            'present'
        );
        await store.close();
        await expect(f.recovery.recover(f.client)).rejects.toThrow(
            'Already committed work must not reconnect'
        );
        expect(f.counts().connects).toBe(1);
        expect(f.killed).toEqual([]);
        expect(await f.recovery.exists()).toBeTrue();
        f.client.connectSandbox = async () => f.sandbox;
        const recovered = await f.recovery.recover(f.client);
        expect(recovered.id).not.toBe(checkpoint.id);
        expect(recovered.turn_index).toBeUndefined();
        expect(
            recovered.warnings.some((warning) => warning.code === 'recovered_outcome')
        ).toBeTrue();
        expect(f.killed).toEqual([f.sandbox.id]);
        expect(await store.read(checkpoint.id)).toEqual(checkpoint);
        expect((await f.runs.read(f.run.id)).outcome_id).toBe(recovered.id);
    });
    test('protects live capture from recovery and discard without contacting cloud services', async () => {
        const f = await fixture();
        expect((await f.recovery.review()).active).toBe(true);
        await expect(f.recovery.discardPending(f.client)).rejects.toThrow(
            'worker is active'
        );
        await expect(f.recovery.recover(f.client)).rejects.toThrow('worker is active');
        expect(f.counts()).toEqual({ lists: 0, connects: 0 });
        expect(f.killed).toEqual([]);
        expect(await f.recovery.exists()).toBe(true);
    });

    test('reports private retained bytes, protects history, and discards only its owned sandbox', async () => {
        const f = await fixture();
        await f.recovery.retain(f.sandbox, new Set());
        const original = Buffer.from([0, 1, 255]);
        await writeFile(join(f.recovery.directory, 'pending.bin'), original, {
            mode: 0o600,
        });
        const reviews = await E2BOutcomeRecovery.listPending(f.home);
        expect(reviews).toHaveLength(1);
        const pending = reviews[0];
        if (!pending) throw new Error('Expected original sandbox recovery');
        expect(pending).toMatchObject({
            run_id: f.run.id,
            sandbox_id: f.sandbox.id,
            active: false,
        });
        expect(pending.bytes).toBe(
            (await stat(join(f.recovery.directory, 'recovery.json'))).size +
                original.length
        );
        expect(
            (await stat(join(f.recovery.directory, 'recovery.json'))).mode & 0o777
        ).toBe(0o600);
        const retention = new SessionRetention(f.home);
        const policy = {
            before: new Date(),
            includeResumableSessions: true,
        };
        const review = await retention.review(policy);
        expect(review.protectedOutcomeRecoveries).toEqual(reviews);
        expect(review.runs).toEqual([]);
        expect((await retention.apply(policy)).removedRuns).toEqual([]);
        f.setManaged([
            { id: 'unrelated', runId: f.run.id, state: 'running' },
            { id: f.sandbox.id, runId: f.run.id, state: 'paused' },
        ]);
        expect(await f.recovery.discardPending(f.client)).toEqual(pending);
        expect(f.killed).toEqual([f.sandbox.id]);
        expect(await f.recovery.exists()).toBe(false);
        expect((await f.runs.read(f.run.id)).status).toBe('failed');
    });

    test('a run ownership mismatch never authorizes cloud deletion', async () => {
        const f = await fixture();
        await f.recovery.retain(f.sandbox, new Set());
        f.setManaged([
            { id: f.sandbox.id, runId: RunStore.createId(), state: 'paused' },
        ]);
        await f.recovery.discardPending(f.client);
        expect(f.killed).toEqual([]);
        expect(await f.recovery.exists()).toBe(false);
    });

    test('cloud deletion failures preserve the recovery checkpoint', async () => {
        const f = await fixture();
        await f.recovery.retain(f.sandbox, new Set());
        f.failKill();
        await expect(f.recovery.discardPending(f.client)).rejects.toThrow(
            'Cloud deletion failed'
        );
        expect(await f.recovery.exists()).toBe(true);
        expect(f.killed).toEqual([]);
    });

    test('retry after durable commit links the same outcome before deleting the original sandbox', async () => {
        const f = await fixture();
        await f.recovery.retain(f.sandbox, new Set());
        const store = new OutcomeStore(f.home);
        const content = await store.putBytes(
            Buffer.from([0, 1, 255]),
            'application/octet-stream'
        );
        const outcome = await store.commit(
            {
                version: 1,
                id: OutcomeStore.createId(),
                run_id: f.run.id,
                created_at: new Date().toISOString(),
                completeness: 'partial',
                changesets: [],
                artifacts: [{ id: 'artifact_original', name: 'original.bin', content }],
                links: [],
                warnings: [],
            },
            'pending'
        );
        await store.close();
        const recordPath = join(f.home, 'runs', f.run.id, 'run.json');
        const originalRecord = await readFile(recordPath);
        await writeFile(recordPath, '{broken');
        await expect(f.recovery.recover(f.client)).rejects.toThrow();
        expect(await f.recovery.exists()).toBe(true);
        expect(f.killed).toEqual([]);
        expect(f.counts().connects).toBe(0);
        await writeFile(recordPath, originalRecord);
        expect(await f.recovery.recover(f.client)).toEqual(outcome);
        expect((await f.runs.read(f.run.id)).outcome_id).toBe(outcome.id);
        expect(await store.list()).toHaveLength(1);
        expect(await readFile(await store.blob(content))).toEqual(
            Buffer.from([0, 1, 255])
        );
        expect((await store.receipt(outcome.id)).state).toBe('pending');
        expect(f.killed).toEqual([f.sandbox.id]);
        expect(f.counts().connects).toBe(0);
        expect(await f.recovery.exists()).toBe(false);
    });

    test('inventory refuses symlinked recovery files and foreign scope records', async () => {
        const f = await fixture();
        const path = join(f.recovery.directory, 'recovery.json');
        const original = await readFile(path, 'utf8');
        await rm(path);
        const outside = join(f.home, 'outside.json');
        await writeFile(outside, original);
        await symlink(outside, path);
        await expect(E2BOutcomeRecovery.listPending(f.home)).rejects.toThrow('Invalid');
        await rm(path);
        await writeFile(path, original.replace(f.identity.scope, 'foreign-scope'));
        await expect(f.recovery.discardPending(f.client)).rejects.toThrow('identity');
        expect(f.counts()).toEqual({ lists: 0, connects: 0 });
    });
});

describe('E2B private recovery record parser', () => {
    function record(): E2BRecoveryRecord {
        return {
            version: 1,
            runId: 'wb_1234567890abcdefghij',
            scope: 'scope',
            sandboxId: 'sandbox',
            ownerPid: 0,
            maximumBytes: 1_024,
            snapshots: [
                {
                    binding: {
                        hostPath: '/project',
                        runtimePath: '/workspace',
                        kind: 'workspace',
                        access: 'read-write',
                        excludedHostPaths: [],
                    },
                    archive: 'workbench-e2b-abc123/asset.tar.gz',
                    excludedPaths: ['.git'],
                    syncExcludedPaths: [],
                    sourceIsDirectory: true,
                },
            ],
            baselines: [[0, 'a'.repeat(40)]],
            persistedState: [],
        };
    }
    test('validates complete typed snapshots instead of trusting private JSON', () => {
        const valid = record();
        const identity = { id: valid.runId, scope: valid.scope };
        expect(parseE2BRecoveryRecord(valid, identity)).toEqual(valid);
        for (const invalid of [
            null,
            { ...valid, ownerPid: -1 },
            { ...valid, maximumBytes: 2 ** 30 },
            { ...valid, baselines: [[1, 'a'.repeat(40)]] },
            { ...valid, baselines: [[0, 'main']] },
            { ...valid, baselines: [] },
            { ...valid, persistedState: [0] },
            { ...valid, snapshots: [null] },
        ])
            expect(() => parseE2BRecoveryRecord(invalid, identity)).toThrow();
        const snapshot = valid.snapshots[0];
        if (!snapshot) throw new Error('Missing snapshot fixture');
        for (const invalid of [
            { ...snapshot, archive: '../asset.tar.gz' },
            { ...snapshot, excludedPaths: [null] },
            { ...snapshot, syncExcludedPaths: ['../outside'] },
            { ...snapshot, binding: { ...snapshot.binding, kind: 'unknown' } },
            { ...snapshot, binding: { ...snapshot.binding, access: 'write' } },
            { ...snapshot, binding: { ...snapshot.binding, hostPath: '/project\n' } },
            {
                ...snapshot,
                binding: { ...snapshot.binding, kind: 'state' },
                archive: undefined,
                stateVersion: 'anything',
            },
        ])
            expect(() =>
                parseE2BRecoveryRecord({ ...valid, snapshots: [invalid] }, identity)
            ).toThrow();
    });
});
