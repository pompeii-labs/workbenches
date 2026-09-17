import { createHash, randomBytes } from 'node:crypto';
import {
    chmod,
    copyFile,
    lstat,
    mkdir,
    readdir,
    readFile,
    rename,
    rm,
    stat,
    writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
    digestFile,
    inferMediaType,
    installExclusive,
    referencedContent,
    validExistingBlob,
    verifyBlob,
} from './content.js';

import type {
    OutcomeApplicationReceipt,
    OutcomeApplicationState,
    OutcomeContentDescriptor,
    OutcomeDigest,
    RunOutcome,
} from './contracts.js';
import { outcomeStorageDirectory } from './directories.js';
import { OutcomeStorageLease, processIsAlive } from './lease.js';
import { materializeOutcomeArtifacts } from './materialize.js';
import {
    atomicWriteJson,
    jsonSource,
    requireMetadataFile,
    writeJson,
} from './metadata.js';
import { formatOutcomeBytes as formatBytes } from './presentation.js';
import { OutcomeStorageQuota } from './quota.js';
import { collectAbandonedOutcomeTemporaries } from './temporaries.js';
import {
    assertOutcomeDigest,
    parseOutcomeApplicationReceipt,
    parseRunOutcome,
} from './validation.js';

const defaultMaximumOutcomeBytes = 512 * 1_024 * 1_024;
const defaultMaximumContentBytes = 256 * 1_024 * 1_024;
const defaultMaximumStoreBytes = 5 * 1_024 * 1_024 * 1_024;
const defaultMaximumMetadataBytes = 16 * 1_024 * 1_024;

export { inferMediaType } from './content.js';

export interface OutcomeStoreOptions {
    maximumOutcomeBytes?: number;
    maximumContentBytes?: number;
    maximumStoreBytes?: number;
    maximumMetadataBytes?: number;
    now?: () => Date;
}

export interface OutcomeGarbageCollection {
    removed_blobs: number;
    removed_bytes: number;
    retained_blobs: number;
}

export class OutcomeStore {
    readonly #maximumOutcomeBytes: number;
    readonly #maximumContentBytes: number;
    readonly #now: () => Date;
    readonly #maximumMetadataBytes: number;
    readonly #quota: OutcomeStorageQuota;
    private capture: Promise<void> | undefined;
    private readonly captureId = crypto.randomUUID();
    private readonly capturedContent = new Map<OutcomeDigest, number>();
    private capturedBytes = 0;

    constructor(
        private readonly home: string,
        options: OutcomeStoreOptions = {}
    ) {
        this.#maximumOutcomeBytes =
            options.maximumOutcomeBytes ?? defaultMaximumOutcomeBytes;
        this.#maximumContentBytes =
            options.maximumContentBytes ?? defaultMaximumContentBytes;
        this.#now = options.now ?? (() => new Date());
        this.#maximumMetadataBytes =
            options.maximumMetadataBytes ?? defaultMaximumMetadataBytes;
        const maximumStoreBytes = options.maximumStoreBytes ?? defaultMaximumStoreBytes;
        this.#quota = new OutcomeStorageQuota(home, maximumStoreBytes);
        requirePositiveLimit(this.#maximumOutcomeBytes, 'maximumOutcomeBytes');
        requirePositiveLimit(this.#maximumContentBytes, 'maximumContentBytes');
        requirePositiveLimit(maximumStoreBytes, 'maximumStoreBytes');
        requirePositiveLimit(this.#maximumMetadataBytes, 'maximumMetadataBytes');
        if (this.#maximumMetadataBytes > defaultMaximumMetadataBytes)
            throw new Error('maximumMetadataBytes cannot exceed 16 MiB');
    }

    static createId(): string {
        return `wbo_${Date.now().toString(36)}${randomBytes(10).toString('hex')}`;
    }

    async putFile(path: string, mediaType = inferMediaType(path)) {
        await this.beginCapture();
        const details = await lstat(path);
        if (details.isSymbolicLink() || !details.isFile()) {
            throw new Error(`Outcome content must be a regular file: ${path}`);
        }
        this.assertContentSize(details.size);
        const digest = await digestFile(path);
        const descriptor: OutcomeContentDescriptor = {
            digest,
            media_type: mediaType,
            size_bytes: details.size,
        };
        this.admitContent(descriptor);
        const target = this.blobPath(digest);
        await this.prepareBlob(digest);
        if (!(await validExistingBlob(target, descriptor))) {
            await mkdir(dirname(target), { recursive: true, mode: 0o700 });
            const temporary = `${target}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
            let existing = false;
            await this.#quota.write(
                async () => {
                    existing = await validExistingBlob(target, descriptor);
                    return existing ? 0 : descriptor.size_bytes;
                },
                async () => {
                    if (existing) return;
                    try {
                        await copyFile(path, temporary);
                        await chmod(temporary, 0o600);
                        await verifyBlob(temporary, descriptor);
                        await installExclusive(temporary, target);
                    } finally {
                        await rm(temporary, { force: true });
                    }
                }
            );
        }
        return descriptor;
    }

    async putBytes(
        bytes: Uint8Array | string,
        mediaType: string
    ): Promise<OutcomeContentDescriptor> {
        await this.beginCapture();
        const source = typeof bytes === 'string' ? Buffer.from(bytes) : bytes;
        this.assertContentSize(source.byteLength);
        const digest =
            `sha256:${createHash('sha256').update(source).digest('hex')}` as const;
        const descriptor: OutcomeContentDescriptor = {
            digest,
            media_type: mediaType,
            size_bytes: source.byteLength,
        };
        this.admitContent(descriptor);
        const target = this.blobPath(digest);
        await this.prepareBlob(digest);
        if (!(await validExistingBlob(target, descriptor))) {
            await mkdir(dirname(target), { recursive: true, mode: 0o700 });
            const temporary = `${target}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
            let existing = false;
            await this.#quota.write(
                async () => {
                    existing = await validExistingBlob(target, descriptor);
                    return existing ? 0 : descriptor.size_bytes;
                },
                async () => {
                    if (existing) return;
                    try {
                        await writeFile(temporary, source, { mode: 0o600, flag: 'wx' });
                        await installExclusive(temporary, target);
                    } finally {
                        await rm(temporary, { force: true });
                    }
                }
            );
        }
        return descriptor;
    }

    async commit(
        candidate: RunOutcome,
        applicationState: OutcomeApplicationState
    ): Promise<RunOutcome> {
        await this.beginCapture();
        const outcome = parseRunOutcome(candidate);
        if (outcome.turn_index !== undefined && applicationState !== 'present') {
            throw new Error('Turn snapshots must have a present receipt');
        }
        const directory = this.outcomeDirectory(outcome.id);
        await outcomeStorageDirectory(this.home, ['outcomes'], true);
        if (await stat(directory).catch(() => undefined)) {
            throw new Error(`Outcome already exists: ${outcome.id}`);
        }
        const descriptors = referencedContent(outcome);
        const unique = new Map(descriptors.map((value) => [value.digest, value]));
        for (const descriptor of descriptors) {
            if (unique.get(descriptor.digest)?.size_bytes !== descriptor.size_bytes)
                throw new Error(
                    'Outcome references disagree about shared content size'
                );
        }
        const total = [...unique.values()].reduce(
            (sum, descriptor) => sum + descriptor.size_bytes,
            0
        );
        if (total > this.#maximumOutcomeBytes) {
            throw new Error(
                `Outcome content exceeds the ${formatBytes(this.#maximumOutcomeBytes)} safety limit`
            );
        }
        for (const descriptor of unique.values()) {
            await this.blob(descriptor);
        }
        const temporary = `${directory}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
        const now = this.#now().toISOString();
        const receipt = parseOutcomeApplicationReceipt({
            version: 1,
            outcome_id: outcome.id,
            state: applicationState,
            updated_at: now,
        });
        const manifestSource = jsonSource(outcome);
        const receiptSource = jsonSource(receipt);
        if (Buffer.byteLength(manifestSource) > this.#maximumMetadataBytes)
            throw new Error('Outcome metadata exceeds its safety limit');
        await this.#quota.write(
            Buffer.byteLength(manifestSource) + Buffer.byteLength(receiptSource),
            async () => {
                try {
                    await mkdir(dirname(directory), { recursive: true, mode: 0o700 });
                    await mkdir(temporary, { recursive: false, mode: 0o700 });
                    await Promise.all([
                        writeFile(join(temporary, 'outcome.json'), manifestSource, {
                            mode: 0o600,
                            flag: 'wx',
                        }),
                        writeFile(join(temporary, 'application.json'), receiptSource, {
                            mode: 0o600,
                            flag: 'wx',
                        }),
                    ]);
                    await rename(temporary, directory);
                } catch (error) {
                    await rm(temporary, { recursive: true, force: true });
                    throw error;
                }
            }
        );
        return outcome;
    }

    async read(id: string): Promise<RunOutcome> {
        validateOutcomeId(id);
        await outcomeStorageDirectory(this.home, ['outcomes', id]);
        await requireMetadataFile(this.manifestPath(id));
        const source = await readFile(this.manifestPath(id), 'utf8').catch((error) => {
            if (isNodeError(error, 'ENOENT')) return null;
            throw error;
        });
        if (!source) throw new Error(`Outcome does not exist: ${id}`);
        const outcome = parseRunOutcome(JSON.parse(source));
        if (outcome.id !== id)
            throw new Error(
                'Outcome metadata identity does not match its storage path'
            );
        return outcome;
    }

    async receipt(id: string): Promise<OutcomeApplicationReceipt> {
        validateOutcomeId(id);
        await outcomeStorageDirectory(this.home, ['outcomes', id]);
        await requireMetadataFile(this.receiptPath(id));
        const source = await readFile(this.receiptPath(id), 'utf8').catch((error) => {
            if (isNodeError(error, 'ENOENT')) return null;
            throw error;
        });
        if (!source)
            throw new Error(`Outcome application receipt does not exist: ${id}`);
        const receipt = parseOutcomeApplicationReceipt(JSON.parse(source));
        if (receipt.outcome_id !== id)
            throw new Error('Outcome receipt identity does not match its storage path');
        return receipt;
    }

    async markApplied(id: string): Promise<OutcomeApplicationReceipt> {
        const current = await this.receipt(id);
        if (current.state === 'present') {
            throw new Error('Outcome changes are already present in the workspace');
        }
        if (current.state === 'applied') return current;
        const now = this.#now().toISOString();
        const next: OutcomeApplicationReceipt = {
            version: 1,
            outcome_id: id,
            state: 'applied',
            updated_at: now,
            applied_at: now,
        };
        const before = (await lstat(this.receiptPath(id))).size;
        await this.#quota.write(
            Buffer.byteLength(jsonSource(next)),
            () => atomicWriteJson(this.receiptPath(id), next),
            before
        );
        return next;
    }

    async withApplicationLease<T>(id: string, operation: () => Promise<T>): Promise<T> {
        validateOutcomeId(id);
        await outcomeStorageDirectory(
            this.home,
            ['outcomes', '.applications', id],
            true
        );
        return new OutcomeStorageLease(
            join(this.home, 'outcomes', '.applications', id)
        ).exclusive(operation);
    }

    async findByRun(runId: string): Promise<RunOutcome | undefined> {
        return (await this.listByRun(runId))[0];
    }

    async findFinalByRun(runId: string): Promise<RunOutcome | undefined> {
        return (await this.listByRun(runId)).find(
            (outcome) => outcome.turn_index === undefined
        );
    }

    async listByRun(runId: string): Promise<RunOutcome[]> {
        return (await this.list()).filter((outcome) => outcome.run_id === runId);
    }

    async list(): Promise<RunOutcome[]> {
        await outcomeStorageDirectory(this.home, ['outcomes']);
        const root = this.outcomesRoot();
        const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
        const outcomes: RunOutcome[] = [];
        for (const entry of entries) {
            if (!entry.isDirectory() || !entry.name.startsWith('wbo_')) continue;
            const outcome = await this.read(entry.name).catch(() => undefined);
            if (outcome) outcomes.push(outcome);
        }
        return outcomes.toSorted(
            (left, right) =>
                right.created_at.localeCompare(left.created_at) ||
                (right.turn_index ?? Number.MAX_SAFE_INTEGER) -
                    (left.turn_index ?? Number.MAX_SAFE_INTEGER) ||
                right.id.localeCompare(left.id)
        );
    }

    async blob(descriptor: OutcomeContentDescriptor): Promise<string> {
        const path = this.blobPath(descriptor.digest);
        await this.prepareBlob(descriptor.digest, false);
        await verifyBlob(path, descriptor);
        return path;
    }

    async artifactPath(outcomeId: string, artifactId: string): Promise<string> {
        const outcome = await this.read(outcomeId);
        if (!outcome.artifacts.some((value) => value.id === artifactId))
            throw new Error(`Outcome artifact does not exist: ${artifactId}`);
        const paths = await materializeOutcomeArtifacts(
            this.home,
            outcome,
            this,
            this.#quota
        );
        return paths.get(artifactId) as string;
    }

    async artifactPaths(outcomeId: string): Promise<Map<string, string>> {
        return materializeOutcomeArtifacts(
            this.home,
            await this.read(outcomeId),
            this,
            this.#quota
        );
    }

    async remove(id: string): Promise<void> {
        validateOutcomeId(id);
        await outcomeStorageDirectory(this.home, ['outcomes', id]);
        await outcomeStorageDirectory(this.home, ['blobs'], true);
        await new OutcomeStorageLease(this.blobsRoot()).exclusive(async () => {
            await rm(this.outcomeDirectory(id), { recursive: true, force: true });
            await this.#quota.refreshExclusive();
        });
    }

    async size(id: string): Promise<number> {
        const outcome = await this.read(id);
        const unique = new Map(
            referencedContent(outcome).map((descriptor) => [
                descriptor.digest,
                descriptor.size_bytes,
            ])
        );
        const metadata = await Promise.all([
            stat(this.manifestPath(id)),
            stat(this.receiptPath(id)),
        ]);
        return (
            [...unique.values()].reduce((sum, bytes) => sum + bytes, 0) +
            metadata.reduce((sum, details) => sum + details.size, 0)
        );
    }

    async metadataSize(id: string): Promise<number> {
        validateOutcomeId(id);
        return directorySize(this.outcomeDirectory(id));
    }

    /** Counts shared content only if every referencing outcome is selected. */
    async reclaimableContentBytes(ids: string[]): Promise<number> {
        if (await this.hasActiveCaptures()) return 0;
        const selected = new Set(ids);
        const removable = new Map<OutcomeDigest, number>();
        const retained = new Set<OutcomeDigest>();
        for (const outcome of await this.list()) {
            for (const content of referencedContent(outcome)) {
                if (selected.has(outcome.id))
                    removable.set(content.digest, content.size_bytes);
                else retained.add(content.digest);
            }
        }
        return [...removable].reduce(
            (total, [digest, size]) => total + (retained.has(digest) ? 0 : size),
            0
        );
    }

    async collectGarbage(): Promise<OutcomeGarbageCollection> {
        await outcomeStorageDirectory(this.home, ['blobs'], true);
        return new OutcomeStorageLease(this.blobsRoot()).exclusive(() =>
            this.collectGarbageExclusive()
        );
    }

    async close(): Promise<void> {
        if (!this.capture) return;
        await this.capture;
        await new OutcomeStorageLease(this.blobsRoot()).exclusive(async () => {
            await rm(this.capturePath(), { force: true });
            this.capture = undefined;
            this.capturedContent.clear();
            this.capturedBytes = 0;
            await this.collectGarbageExclusive();
        });
    }

    private beginCapture(): Promise<void> {
        if (!this.capture) {
            this.capture = outcomeStorageDirectory(this.home, ['blobs'], true)
                .then(() =>
                    new OutcomeStorageLease(this.blobsRoot()).exclusive(async () => {
                        await outcomeStorageDirectory(
                            this.home,
                            ['blobs', '.captures'],
                            true
                        );
                        await this.#quota.refreshExclusive();
                        await writeJson(this.capturePath(), { pid: process.pid });
                    })
                )
                .catch((error) => {
                    this.capture = undefined;
                    throw error;
                });
        }
        return this.capture;
    }

    private capturePath(): string {
        return join(this.blobsRoot(), '.captures', `${this.captureId}.json`);
    }

    private async hasActiveCaptures(): Promise<boolean> {
        await outcomeStorageDirectory(this.home, ['blobs', '.captures']);
        const directory = join(this.blobsRoot(), '.captures');
        const files = await readdir(directory, { withFileTypes: true }).catch(
            (error) => {
                if (isNodeError(error, 'ENOENT')) return [];
                throw error;
            }
        );
        let active = false;
        for (const file of files) {
            if (!/^[a-f0-9-]{36}\.json$/.test(file.name)) continue;
            if (!file.isFile() || file.isSymbolicLink())
                throw new Error('Invalid outcome capture lease');
            const path = join(directory, file.name);
            await requireMetadataFile(path);
            const value: unknown = JSON.parse(await readFile(path, 'utf8'));
            const pid =
                value && typeof value === 'object'
                    ? Reflect.get(value, 'pid')
                    : undefined;
            if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0)
                throw new Error('Invalid outcome capture lease');
            if (processIsAlive(pid)) active = true;
            else await rm(path, { force: true });
        }
        return active;
    }

    private async collectGarbageExclusive(): Promise<OutcomeGarbageCollection> {
        await outcomeStorageDirectory(this.home, ['outcomes']);
        await outcomeStorageDirectory(this.home, ['blobs', 'sha256']);
        const referenced = new Set<OutcomeDigest>();
        const retainedOutcomes: RunOutcome[] = [];
        const manifests = await readdir(this.outcomesRoot(), {
            withFileTypes: true,
        }).catch((error) => {
            if (isNodeError(error, 'ENOENT')) return [];
            throw error;
        });
        for (const manifest of manifests) {
            if (!/^wbo_[a-z0-9]{20,64}$/.test(manifest.name)) continue;
            const outcome = await this.read(manifest.name);
            retainedOutcomes.push(outcome);
            for (const descriptor of referencedContent(outcome)) {
                referenced.add(descriptor.digest);
            }
        }
        let removedBlobs = 0;
        let removedBytes = await collectAbandonedOutcomeTemporaries(
            this.home,
            retainedOutcomes
        );
        let retainedBlobs = 0;
        const active = await this.hasActiveCaptures();
        const algorithm = join(this.blobsRoot(), 'sha256');
        const prefixes = await readdir(algorithm, { withFileTypes: true }).catch(
            (error) => {
                if (isNodeError(error, 'ENOENT')) return [];
                throw error;
            }
        );
        for (const prefix of prefixes) {
            if (prefix.isSymbolicLink())
                throw new Error('Outcome content prefix must not be a symlink');
            if (!prefix.isDirectory() || !/^[a-f0-9]{2}$/.test(prefix.name)) continue;
            const directory = join(algorithm, prefix.name);
            const blobs = await readdir(directory, { withFileTypes: true });
            for (const blob of blobs) {
                if (!blob.isFile() || !/^[a-f0-9]{62}$/.test(blob.name)) continue;
                const digest = `sha256:${prefix.name}${blob.name}` as OutcomeDigest;
                if (active || referenced.has(digest)) {
                    retainedBlobs += 1;
                    continue;
                }
                const path = join(directory, blob.name);
                const details = await stat(path);
                await rm(path, { force: true });
                removedBlobs += 1;
                removedBytes += details.size;
            }
        }
        await this.#quota.refreshExclusive();
        return {
            removed_blobs: removedBlobs,
            removed_bytes: removedBytes,
            retained_blobs: retainedBlobs,
        };
    }

    private assertContentSize(bytes: number): void {
        if (bytes > this.#maximumContentBytes) {
            throw new Error(
                `Outcome content exceeds the ${formatBytes(this.#maximumContentBytes)} per-file safety limit`
            );
        }
    }

    private admitContent(descriptor: OutcomeContentDescriptor): void {
        const existing = this.capturedContent.get(descriptor.digest);
        if (existing !== undefined) {
            if (existing !== descriptor.size_bytes)
                throw new Error(
                    'Outcome references disagree about shared content size'
                );
            return;
        }
        if (descriptor.size_bytes > this.#maximumOutcomeBytes - this.capturedBytes)
            throw new Error('Outcome content exceeds its aggregate safety limit');
        this.capturedContent.set(descriptor.digest, descriptor.size_bytes);
        this.capturedBytes += descriptor.size_bytes;
    }

    private outcomesRoot(): string {
        return join(this.home, 'outcomes');
    }

    private outcomeDirectory(id: string): string {
        validateOutcomeId(id);
        return join(this.outcomesRoot(), id);
    }

    private manifestPath(id: string): string {
        return join(this.outcomeDirectory(id), 'outcome.json');
    }

    private receiptPath(id: string): string {
        return join(this.outcomeDirectory(id), 'application.json');
    }

    private blobsRoot(): string {
        return join(this.home, 'blobs');
    }

    private blobPath(digest: OutcomeDigest): string {
        const validated = assertOutcomeDigest(digest).slice('sha256:'.length);
        return join(
            this.blobsRoot(),
            'sha256',
            validated.slice(0, 2),
            validated.slice(2)
        );
    }

    private prepareBlob(digest: OutcomeDigest, create = true): Promise<void> {
        const value = assertOutcomeDigest(digest).slice('sha256:'.length);
        return outcomeStorageDirectory(
            this.home,
            ['blobs', 'sha256', value.slice(0, 2)],
            create
        );
    }
}

async function directorySize(path: string): Promise<number> {
    const details = await lstat(path);
    if (details.isFile()) return details.size;
    if (!details.isDirectory() || details.isSymbolicLink()) return 0;
    const entries = await readdir(path);
    const sizes = await Promise.all(
        entries.map((entry) => directorySize(join(path, entry)))
    );
    return sizes.reduce((total, bytes) => total + bytes, 0);
}

function validateOutcomeId(id: string): void {
    if (!/^wbo_[a-z0-9]{20,64}$/.test(id)) {
        throw new Error(`Invalid outcome ID: ${id}`);
    }
}

function requirePositiveLimit(value: number, name: string): void {
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`${name} must be a positive integer`);
    }
}

function isNodeError(error: unknown, code: string): boolean {
    return (
        error instanceof Error &&
        'code' in error &&
        (error as NodeJS.ErrnoException).code === code
    );
}
