import { isAbsolute } from 'node:path';
import { assertSafeOutcomePath } from '../../outcomes/validation.js';
import type { E2BAssetBinding } from './paths.js';
import type { E2BRecoverySnapshot } from './snapshot.js';

export interface E2BRecoveryRecord {
    version: 1;
    runId: string;
    scope: string;
    sandboxId: string;
    ownerPid: number;
    maximumBytes: number;
    snapshots: E2BRecoverySnapshot[];
    baselines: Array<[number, string]>;
    persistedState: number[];
}

export function parseE2BRecoveryRecord(
    value: unknown,
    run: { id: string; scope: string }
): E2BRecoveryRecord {
    const record = object(value);
    if (record.version !== 1 || record.runId !== run.id || record.scope !== run.scope)
        throw new Error('Invalid E2B outcome recovery identity');
    const ownerPid = integer(record.ownerPid);
    const maximumBytes = integer(record.maximumBytes);
    if (maximumBytes === 0 || maximumBytes > 512 * 1_024 * 1_024)
        throw new Error('Invalid E2B outcome recovery safety limit');
    const snapshots = array(record.snapshots, 256).map(parseSnapshot);
    const baselines = array(record.baselines, 256).map((item): [number, string] => {
        if (!Array.isArray(item) || item.length !== 2)
            throw new Error('Invalid E2B outcome recovery baseline');
        const index = snapshotIndex(item[0], snapshots);
        const revision = string(item[1]);
        if (!/^[a-f0-9]{40,64}$/.test(revision))
            throw new Error('Invalid E2B outcome recovery baseline');
        return [index, revision];
    });
    const persistedState = array(record.persistedState, 256).map((value) => {
        const index = snapshotIndex(value, snapshots);
        const kind = snapshots[index]?.binding.kind;
        if (kind !== 'state' && kind !== 'credentials')
            throw new Error('Invalid E2B outcome recovery native state index');
        return index;
    });
    unique(baselines.map(([index]) => index));
    unique(persistedState);
    unique(snapshots.map((snapshot) => snapshot.binding.runtimePath));
    unique(snapshots.map((snapshot) => snapshot.binding.hostPath));
    const baselineIndexes = new Set(baselines.map(([index]) => index));
    for (const [index, snapshot] of snapshots.entries()) {
        if (
            snapshot.binding.kind === 'workspace' &&
            snapshot.binding.access === 'read-write' &&
            !baselineIndexes.has(index)
        )
            throw new Error('E2B outcome recovery workspace baseline is missing');
    }
    return {
        version: 1,
        runId: run.id,
        scope: run.scope,
        sandboxId: string(record.sandboxId),
        ownerPid,
        maximumBytes,
        snapshots,
        baselines,
        persistedState,
    };
}

function parseSnapshot(value: unknown): E2BRecoverySnapshot {
    const record = object(value);
    const raw = object(record.binding);
    const kind = oneOf(raw.kind, [
        'workspace',
        'package',
        'asset',
        'credentials',
        'state',
        'outcome',
    ] as const);
    const workspace = raw.workspace === undefined ? undefined : string(raw.workspace);
    if (
        workspace &&
        (kind !== 'workspace' || !/^[a-z][a-z0-9-]{0,63}$/.test(workspace))
    )
        throw new Error('Invalid E2B outcome recovery named workspace');
    const binding: E2BAssetBinding = {
        hostPath: absolutePath(raw.hostPath),
        runtimePath: absolutePath(raw.runtimePath),
        access: oneOf(raw.access, ['read-only', 'read-write'] as const),
        kind,
        excludedHostPaths: array(raw.excludedHostPaths, 16_384).map(absolutePath),
        ...(workspace ? { workspace } : {}),
    };
    if (typeof record.sourceIsDirectory !== 'boolean')
        throw new Error('Invalid E2B outcome recovery snapshot');
    const archive = record.archive === undefined ? undefined : string(record.archive);
    if (
        archive !== undefined &&
        !/^workbench-e2b-[A-Za-z0-9]+\/asset\.tar\.gz$/.test(archive)
    )
        throw new Error('Unsafe E2B recovery archive');
    if ((kind === 'workspace') !== Boolean(archive))
        throw new Error('Invalid E2B outcome recovery workspace archive');
    const stateVersion =
        record.stateVersion === undefined ? undefined : string(record.stateVersion);
    if (kind === 'state' || kind === 'credentials') {
        if (
            !stateVersion ||
            !/^(?:sha256:[a-f0-9]{64}|generation:[a-f0-9-]{36})$/.test(stateVersion)
        )
            throw new Error('Invalid E2B outcome recovery native state version');
    } else if (stateVersion)
        throw new Error('Invalid E2B outcome recovery native state version');
    const gitRevision =
        record.gitRevision === undefined ? undefined : string(record.gitRevision);
    if (gitRevision && !/^[a-f0-9]{40,64}$/.test(gitRevision))
        throw new Error('Invalid E2B outcome recovery Git revision');
    return {
        binding,
        excludedPaths: array(record.excludedPaths, 16_384).map((value) =>
            assertSafeOutcomePath(string(value))
        ),
        syncExcludedPaths: array(record.syncExcludedPaths, 16_384).map((value) =>
            assertSafeOutcomePath(string(value))
        ),
        sourceIsDirectory: record.sourceIsDirectory,
        ...(archive ? { archive } : {}),
        ...(stateVersion ? { stateVersion } : {}),
        ...(gitRevision ? { gitRevision } : {}),
    };
}

function object(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('Invalid E2B outcome recovery record');
    return Object.fromEntries(Object.entries(value));
}
function string(value: unknown): string {
    if (
        typeof value !== 'string' ||
        !value ||
        value.length > 4_096 ||
        /\p{Cc}/u.test(value)
    )
        throw new Error('Invalid E2B outcome recovery string');
    return value;
}
function absolutePath(value: unknown): string {
    const path = string(value);
    if (!isAbsolute(path))
        throw new Error('Invalid E2B outcome recovery absolute path');
    return path;
}
function integer(value: unknown): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
        throw new Error('Invalid E2B outcome recovery integer');
    return value;
}
function snapshotIndex(value: unknown, snapshots: E2BRecoverySnapshot[]): number {
    const index = integer(value);
    if (index >= snapshots.length)
        throw new Error('Invalid E2B outcome recovery snapshot index');
    return index;
}
function array(value: unknown, maximum: number): unknown[] {
    if (!Array.isArray(value) || value.length > maximum)
        throw new Error('Invalid E2B outcome recovery array');
    return value;
}
function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T {
    for (const candidate of allowed) if (value === candidate) return candidate;
    throw new Error('Invalid E2B outcome recovery binding');
}
function unique(values: Array<string | number>): void {
    if (new Set(values).size !== values.length)
        throw new Error('Duplicate E2B outcome recovery entries');
}
