import type { Connection } from '../database/connection.js';
import { RowReader } from '../database/rows.js';
import {
    parseRepository,
    type RepositoryDeliveryReceipt,
    validRepositoryRef,
} from './contracts.js';

const MAXIMUM_RECEIPT_BYTES = 32_768;

/** Delivery receipts, one per run and one per session (the latest attempt). */
export class RepositoryDeliveryStore {
    constructor(
        private readonly database: Pick<Connection, 'run' | 'one' | 'transaction'>
    ) {}

    async read(runId: string): Promise<RepositoryDeliveryReceipt | undefined> {
        this.assertIdentifier(runId);
        return this.load('run', runId, runId);
    }

    async readSession(
        sessionId: string
    ): Promise<RepositoryDeliveryReceipt | undefined> {
        this.assertIdentifier(sessionId);
        const receipt = this.load('session', sessionId);
        if (receipt && receipt.session_id !== sessionId)
            throw new Error('GitHub receipt belongs to a different session');
        return receipt;
    }

    async write(receipt: RepositoryDeliveryReceipt): Promise<void> {
        this.assertIdentifier(receipt.run_id);
        if (receipt.session_id) this.assertIdentifier(receipt.session_id);
        const payload = JSON.stringify(receipt);
        this.database.transaction(() => {
            if (receipt.session_id) this.save('session', receipt.session_id, payload);
            this.save('run', receipt.run_id, payload);
        });
    }

    private save(scope: 'run' | 'session', id: string, payload: string): void {
        this.database.run(
            `INSERT INTO repository_receipts (scope, id, payload) VALUES (?, ?, ?)
             ON CONFLICT (scope, id) DO UPDATE SET payload = excluded.payload`,
            scope,
            id,
            payload
        );
    }

    private load(
        scope: 'run' | 'session',
        id: string,
        runId?: string
    ): RepositoryDeliveryReceipt | undefined {
        const row = this.database.one(
            'SELECT payload FROM repository_receipts WHERE scope = ? AND id = ?',
            scope,
            id
        );
        if (!row) return undefined;
        if (
            typeof row.payload !== 'string' ||
            Buffer.byteLength(row.payload) > MAXIMUM_RECEIPT_BYTES
        )
            throw new Error('Invalid repository delivery receipt');
        let value: unknown;
        try {
            value = JSON.parse(row.payload);
        } catch {
            throw new Error('Invalid repository delivery receipt');
        }
        return this.validate(value, runId);
    }

    private validate(value: unknown, runId?: string): RepositoryDeliveryReceipt {
        if (!RowReader.isRecord(value))
            throw new Error('Invalid repository delivery receipt');
        const receipt = value as unknown as RepositoryDeliveryReceipt;
        parseRepository(receipt.repository);
        if (
            receipt.version !== 1 ||
            !validRepositoryRef(receipt.base_branch) ||
            typeof receipt.created_at !== 'string' ||
            !Number.isFinite(Date.parse(receipt.created_at)) ||
            (runId !== undefined && receipt.run_id !== runId) ||
            !/^wb_[a-z0-9]{20,64}$/.test(receipt.run_id) ||
            (receipt.session_id !== undefined &&
                !/^wb_[a-z0-9]{20,64}$/.test(receipt.session_id)) ||
            !['publishing', 'published', 'failed', 'unchanged'].includes(
                receipt.state
            ) ||
            receipt.branch !== `workbenches/${receipt.session_id ?? receipt.run_id}` ||
            (receipt.parent !== undefined && !/^[a-f0-9]{40}$/.test(receipt.parent)) ||
            (receipt.updated !== undefined && typeof receipt.updated !== 'boolean') ||
            [receipt.title, receipt.body, receipt.commit_message].some(
                (entry) =>
                    entry !== undefined &&
                    (typeof entry !== 'string' || entry.length > 16_384)
            ) ||
            !/^wbo_[a-z0-9]{20,64}$/.test(receipt.outcome_id) ||
            !/^[a-f0-9]{40}$/.test(receipt.revision) ||
            (receipt.tree !== undefined && !/^[a-f0-9]{40}$/.test(receipt.tree)) ||
            (receipt.commit !== undefined && !/^[a-f0-9]{40}$/.test(receipt.commit)) ||
            (receipt.message !== undefined &&
                (typeof receipt.message !== 'string' ||
                    receipt.message.length > 16_384)) ||
            (receipt.state === 'published' &&
                (!receipt.commit || !receipt.tree || !receipt.pull_request)) ||
            (receipt.pull_request !== undefined &&
                (!Number.isSafeInteger(receipt.pull_request.number) ||
                    receipt.pull_request.number < 1 ||
                    typeof receipt.pull_request.url !== 'string' ||
                    receipt.pull_request.url.toLowerCase() !==
                        `https://github.com/${receipt.repository}/pull/${receipt.pull_request.number}`.toLowerCase()))
        )
            throw new Error('Invalid repository delivery receipt');
        return receipt;
    }

    private assertIdentifier(id: string): void {
        if (!/^wb_[a-z0-9]{20,64}$/.test(id))
            throw new Error('Invalid repository run ID');
    }
}
