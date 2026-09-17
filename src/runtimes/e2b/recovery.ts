import { lstat, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RunOutcome } from '../../outcomes/contracts.js';
import { outcomeStorageDirectory } from '../../outcomes/directories.js';
import { OutcomeStorageLease, processIsAlive } from '../../outcomes/lease.js';
import { OutcomeStore } from '../../outcomes/store.js';
import { RunStore } from '../../runs/store.js';
import {
    parseE2BRecoveryRecord,
    type E2BRecoveryRecord as RecoveryRecord,
} from './checkpoint.js';
import { E2BOutcomeCollector } from './collector.js';
import type { E2BClient, E2BSandbox } from './contracts.js';
import { captureE2BNativeState } from './native.js';
import { E2BAssetSnapshot } from './snapshot.js';

export interface E2BRecoveryReview {
    run_id: string;
    sandbox_id: string;
    bytes: number;
    active: boolean;
}

/** Private input checkpoints preserve the original baseline, not a live host rescan. */
export class E2BOutcomeRecovery {
    readonly directory: string;
    private record: RecoveryRecord | undefined;
    constructor(
        private readonly home: string,
        readonly run: { id: string; scope: string }
    ) {
        RunStore.validateId(run.id);
        if (run.scope !== RunStore.scope(home))
            throw new Error('Outcome recovery scope does not match its storage home');
        this.directory = join(home, 'recovery', 'e2b', run.id);
    }

    async prepare(): Promise<void> {
        await outcomeStorageDirectory(
            this.home,
            ['recovery', 'e2b', this.run.id],
            true
        );
        if (await this.exists())
            throw new Error('E2B outcome recovery already exists for this run');
    }

    async exists(): Promise<boolean> {
        await outcomeStorageDirectory(this.home, ['recovery', 'e2b', this.run.id]);
        return Boolean(
            await lstat(join(this.directory, 'recovery.json')).catch((error) => {
                if (
                    error instanceof Error &&
                    'code' in error &&
                    error.code === 'ENOENT'
                )
                    return undefined;
                throw error;
            })
        );
    }

    async checkpoint(
        sandbox: E2BSandbox,
        snapshots: E2BAssetSnapshot[],
        baselines: Map<number, string>,
        maximumBytes: number
    ): Promise<void> {
        this.record = {
            version: 1,
            runId: this.run.id,
            scope: this.run.scope,
            sandboxId: sandbox.id,
            ownerPid: process.pid,
            maximumBytes,
            snapshots: snapshots.map((snapshot) =>
                snapshot.recoverySnapshot(this.directory)
            ),
            baselines: [...baselines],
            persistedState: [],
        };
        await this.write(this.record);
    }

    async retain(sandbox: E2BSandbox, persistedState: Set<number>): Promise<void> {
        if (!this.record) return;
        this.record.ownerPid = 0;
        this.record.persistedState = [...persistedState];
        await this.write(this.record);
        await sandbox.pause?.();
    }

    async progress(persistedState: Set<number>): Promise<void> {
        if (!this.record) return;
        this.record.persistedState = [...persistedState];
        await this.write(this.record);
    }

    static async listPending(home: string): Promise<E2BRecoveryReview[]> {
        await outcomeStorageDirectory(home, ['recovery', 'e2b']);
        const entries = await readdir(join(home, 'recovery', 'e2b')).catch((error) => {
            if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
                return [];
            throw error;
        });
        const reviews: E2BRecoveryReview[] = [];
        for (const id of entries) {
            RunStore.validateId(id);
            const recovery = new E2BOutcomeRecovery(home, {
                id,
                scope: RunStore.scope(home),
            });
            if (await recovery.exists()) reviews.push(await recovery.review());
        }
        return reviews;
    }

    async review(): Promise<E2BRecoveryReview> {
        const record = await this.read();
        return {
            run_id: record.runId,
            sandbox_id: record.sandboxId,
            bytes: await privateDirectoryBytes(this.directory),
            active: processIsAlive(record.ownerPid),
        };
    }

    async discardPending(client: E2BClient): Promise<E2BRecoveryReview> {
        await outcomeStorageDirectory(
            this.home,
            ['recovery', '.leases', this.run.id],
            true
        );
        return new OutcomeStorageLease(
            join(this.home, 'recovery', '.leases', this.run.id)
        ).exclusive(async () => {
            const review = await this.review();
            if (review.active)
                throw new Error(
                    'Cannot discard outcomes while their run worker is active'
                );
            const sandbox = (await client.listManaged(this.run.scope)).find(
                (value) => value.id === review.sandbox_id && value.runId === this.run.id
            );
            // Delete cloud resources only after proving both scope and run ownership.
            if (sandbox) await client.killSandbox(sandbox.id);
            await this.discard();
            return review;
        });
    }

    async discard(): Promise<void> {
        await outcomeStorageDirectory(this.home, ['recovery', 'e2b', this.run.id]);
        await rm(this.directory, { recursive: true, force: true });
        this.record = undefined;
    }

    async recover(client: E2BClient): Promise<RunOutcome> {
        await outcomeStorageDirectory(
            this.home,
            ['recovery', '.leases', this.run.id],
            true
        );
        return new OutcomeStorageLease(
            join(this.home, 'recovery', '.leases', this.run.id)
        ).exclusive(async () => {
            const record = await this.read();
            if (processIsAlive(record.ownerPid))
                throw new Error(
                    'Cannot recover outcomes while their run worker is active'
                );
            const store = new OutcomeStore(this.home);
            let sandbox: E2BSandbox | undefined;
            try {
                const managed = (await client.listManaged(record.scope)).find(
                    (value) =>
                        value.id === record.sandboxId && value.runId === record.runId
                );
                // A crash after commit must not produce a second immutable outcome.
                let outcome = await store.findFinalByRun(record.runId);
                if (!outcome) {
                    if (!managed)
                        throw new Error(
                            'Original E2B sandbox is unavailable; no host files were changed'
                        );
                    if (!client.connectSandbox)
                        throw new Error('E2B client does not support outcome recovery');
                    sandbox = await client.connectSandbox(
                        record.sandboxId,
                        5 * 60 * 1_000
                    );
                    const snapshots = record.snapshots.map((value) =>
                        E2BAssetSnapshot.fromRecovery(value, this.directory)
                    );
                    const persisted = new Set(record.persistedState);
                    try {
                        await captureE2BNativeState(
                            sandbox,
                            snapshots,
                            record.maximumBytes,
                            persisted,
                            async (completed) => {
                                record.persistedState = [...completed];
                                await this.write(record);
                            }
                        );
                    } finally {
                        record.persistedState = [...persisted];
                        await this.write(record);
                    }
                    const collected = await new E2BOutcomeCollector({
                        sandbox,
                        snapshots,
                        baselines: new Map(record.baselines),
                        maximumTransferBytes: record.maximumBytes,
                    }).collect(store);
                    outcome = await store.commit(
                        {
                            version: 1,
                            id: OutcomeStore.createId(),
                            run_id: record.runId,
                            created_at: new Date().toISOString(),
                            completeness: 'partial',
                            ...(collected.summary
                                ? { summary: collected.summary }
                                : {}),
                            changesets: collected.changesets,
                            artifacts: collected.artifacts,
                            links: collected.links,
                            warnings: [
                                ...collected.warnings,
                                {
                                    code: 'recovered_outcome',
                                    message:
                                        'Recovered from the original sandbox after interrupted outcome collection. Review partial results before applying.',
                                },
                            ],
                        },
                        'pending'
                    );
                }
                await this.linkRun(outcome);
                if (sandbox) await sandbox.kill();
                else if (managed) await client.killSandbox(record.sandboxId);
                await this.discard();
                return outcome;
            } catch (error) {
                await sandbox?.pause?.().catch(() => {});
                throw error;
            } finally {
                await store.close();
            }
        });
    }

    private async linkRun(outcome: RunOutcome): Promise<void> {
        const runs = new RunStore(this.home);
        const run = await runs.read(outcome.run_id).catch((error) => {
            if (
                error instanceof Error &&
                error.message === `Workbench run does not exist: ${outcome.run_id}`
            )
                return undefined;
            throw error;
        });
        if (run) await runs.update(run.id, { outcome_id: outcome.id });
    }

    private async write(record: RecoveryRecord): Promise<void> {
        const temporary = join(this.directory, `${crypto.randomUUID()}.tmp`);
        try {
            await writeFile(temporary, JSON.stringify(record), {
                mode: 0o600,
                flag: 'wx',
            });
            await rename(temporary, join(this.directory, 'recovery.json'));
        } finally {
            await rm(temporary, { force: true });
        }
    }

    private async read(): Promise<RecoveryRecord> {
        await outcomeStorageDirectory(this.home, ['recovery', 'e2b', this.run.id]);
        const path = join(this.directory, 'recovery.json');
        const details = await lstat(path);
        if (
            !details.isFile() ||
            details.isSymbolicLink() ||
            details.size > 16 * 1_024 * 1_024
        )
            throw new Error('Invalid E2B outcome recovery record');
        const record = parseE2BRecoveryRecord(
            JSON.parse(await readFile(path, 'utf8')),
            this.run
        );
        for (const snapshot of record.snapshots) {
            if (snapshot.archive) {
                const parent = snapshot.archive.split('/')[0];
                if (!parent) throw new Error('Unsafe E2B recovery archive');
                await outcomeStorageDirectory(this.directory, [parent]);
                const archive = await lstat(join(this.directory, snapshot.archive));
                if (!archive.isFile() || archive.isSymbolicLink())
                    throw new Error('Unsafe E2B recovery archive');
            }
        }
        return record;
    }
}

async function privateDirectoryBytes(directory: string): Promise<number> {
    let bytes = 0;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        const details = await lstat(path);
        if (details.isSymbolicLink()) throw new Error('Unsafe E2B recovery storage');
        if (details.isDirectory()) bytes += await privateDirectoryBytes(path);
        else if (details.isFile()) bytes += details.size;
        else throw new Error('Unsafe E2B recovery storage');
    }
    return bytes;
}
