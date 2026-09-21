import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
    parseRepository,
    type RepositoryDeliveryReceipt,
    validRepositoryRef,
} from './contracts.js';

export class RepositoryDeliveryStore {
    constructor(private readonly home: string) {}

    async read(runId: string): Promise<RepositoryDeliveryReceipt | undefined> {
        return this.readPath(this.path(runId), runId);
    }

    async readSession(
        sessionId: string
    ): Promise<RepositoryDeliveryReceipt | undefined> {
        this.path(sessionId);
        const receipt = await this.readPath(
            join(this.home, 'sessions', sessionId, 'github.json')
        );
        if (receipt && receipt.session_id !== sessionId)
            throw new Error('GitHub receipt belongs to a different session');
        return receipt;
    }

    private async readPath(
        path: string,
        runId?: string
    ): Promise<RepositoryDeliveryReceipt | undefined> {
        const details = await lstat(path).catch((error) => {
            if (error?.code === 'ENOENT') return undefined;
            throw error;
        });
        if (!details) return undefined;
        if (!details.isFile() || details.isSymbolicLink() || details.size > 32_768)
            throw new Error('Invalid repository delivery receipt');
        const receipt = JSON.parse(
            await readFile(path, 'utf8')
        ) as RepositoryDeliveryReceipt;
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
                (value) =>
                    value !== undefined &&
                    (typeof value !== 'string' || value.length > 16_384)
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

    async write(receipt: RepositoryDeliveryReceipt): Promise<void> {
        if (receipt.session_id) {
            this.path(receipt.session_id);
            await mkdir(join(this.home, 'sessions', receipt.session_id), {
                recursive: true,
                mode: 0o700,
            });
            await this.writePath(
                join(this.home, 'sessions', receipt.session_id, 'github.json'),
                receipt
            );
        }
        await this.writePath(this.path(receipt.run_id), receipt);
    }

    private async writePath(
        path: string,
        receipt: RepositoryDeliveryReceipt
    ): Promise<void> {
        const temporary = `${path}.${crypto.randomUUID()}.tmp`;
        try {
            await writeFile(temporary, `${JSON.stringify(receipt)}\n`, {
                flag: 'wx',
                mode: 0o600,
            });
            await rename(temporary, path);
        } finally {
            await rm(temporary, { force: true });
        }
    }

    private path(runId: string): string {
        if (!/^wb_[a-z0-9]{20,64}$/.test(runId))
            throw new Error('Invalid repository run ID');
        return join(this.home, 'runs', runId, 'delivery.json');
    }
}
