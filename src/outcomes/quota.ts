import { randomBytes } from 'node:crypto';
import { lstat, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { outcomeStorageDirectory } from './directories.js';
import { OutcomeStorageLease } from './lease.js';

/** Budgets engine-owned result bytes under the same lease as capture and GC. */
export class OutcomeStorageQuota {
    private initialized = false;

    constructor(
        private readonly home: string,
        private readonly maximumBytes: number
    ) {}

    async write<T>(
        requestedBytes: number | (() => Promise<number>),
        operation: () => Promise<T>,
        replacedBytes = 0
    ): Promise<T> {
        await outcomeStorageDirectory(this.home, ['blobs'], true);
        return new OutcomeStorageLease(join(this.home, 'blobs')).exclusive(async () => {
            if (!this.initialized) await this.refreshExclusive();
            const used = await this.read();
            const additionalBytes =
                typeof requestedBytes === 'number'
                    ? requestedBytes
                    : await requestedBytes();
            if (additionalBytes > this.maximumBytes - used) {
                throw new Error(
                    `Outcome storage quota exceeded (${this.maximumBytes} bytes). Review wb clean before removing retained results.`
                );
            }
            // Persist the reservation first. Interrupted writes remain accounted for
            // until the next scan repairs the ledger from actual on-disk files.
            await this.record(used + additionalBytes);
            try {
                const result = await operation();
                // The reservation already accounts for the committed write.
                // Reconcile replaced bytes before the next admission instead of
                // introducing a fallible ledger write after the commit point.
                if (replacedBytes > 0) this.initialized = false;
                return result;
            } catch (error) {
                await this.refreshExclusive();
                throw error;
            }
        });
    }

    /** The caller must hold the shared blob-storage lease. */
    async refreshExclusive(): Promise<void> {
        await outcomeStorageDirectory(this.home, ['blobs'], true);
        await outcomeStorageDirectory(this.home, ['outcomes']);
        const excluded = new Set([
            join(this.home, 'blobs', '.lease'),
            join(this.home, 'blobs', '.captures'),
            join(this.home, 'blobs', '.usage.json'),
            join(this.home, 'outcomes', '.applications'),
        ]);
        const bytes =
            (await resultBytes(join(this.home, 'blobs'), excluded)) +
            (await resultBytes(join(this.home, 'outcomes'), excluded));
        await this.record(bytes);
        this.initialized = true;
    }

    private async read(): Promise<number> {
        const path = join(this.home, 'blobs', '.usage.json');
        const details = await lstat(path);
        if (!details.isFile() || details.isSymbolicLink() || details.size > 1_024)
            throw new Error('Outcome quota ledger must be a bounded regular file');
        const value: unknown = JSON.parse(await readFile(path, 'utf8'));
        const bytes =
            value && typeof value === 'object'
                ? Reflect.get(value, 'bytes')
                : undefined;
        if (
            !value ||
            typeof value !== 'object' ||
            Reflect.get(value, 'version') !== 1 ||
            !Number.isSafeInteger(bytes) ||
            (bytes as number) < 0
        )
            throw new Error('Outcome quota ledger contains an invalid byte count');
        return bytes as number;
    }

    private async record(bytes: number): Promise<void> {
        if (!Number.isSafeInteger(bytes) || bytes < 0)
            throw new Error('Invalid outcome storage accounting');
        const path = join(this.home, 'blobs', '.usage.json');
        const details = await lstat(path).catch((error) => {
            if (hasCode(error, 'ENOENT')) return undefined;
            throw error;
        });
        if (details && (!details.isFile() || details.isSymbolicLink()))
            throw new Error('Outcome quota ledger must be a regular file');
        const temporary = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
        try {
            await writeFile(temporary, JSON.stringify({ version: 1, bytes }), {
                mode: 0o600,
                flag: 'wx',
            });
            await rename(temporary, path);
        } finally {
            await rm(temporary, { force: true });
        }
    }
}

async function resultBytes(directory: string, excluded: Set<string>): Promise<number> {
    const details = await lstat(directory).catch((error) => {
        if (hasCode(error, 'ENOENT')) return undefined;
        throw error;
    });
    if (!details) return 0;
    if (!details.isDirectory() || details.isSymbolicLink())
        throw new Error('Outcome quota storage must use real directories');
    const entries = await readdir(directory, { withFileTypes: true }).catch((error) => {
        if (hasCode(error, 'ENOENT')) return [];
        throw error;
    });
    let bytes = 0;
    for (const entry of entries) {
        const path = join(directory, entry.name);
        if (excluded.has(path)) continue;
        if (entry.isSymbolicLink())
            throw new Error('Outcome quota storage must not contain symlinks');
        if (entry.isDirectory()) bytes += await resultBytes(path, excluded);
        else if (entry.isFile()) {
            const file = await lstat(path);
            if (!file.isFile() || file.isSymbolicLink())
                throw new Error('Outcome quota storage must contain regular files');
            bytes += file.size;
        } else throw new Error('Outcome quota storage must contain regular files');
    }
    return bytes;
}

function hasCode(error: unknown, code: string): boolean {
    return error instanceof Error && 'code' in error && error.code === code;
}
