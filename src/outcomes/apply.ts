import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
    chmod,
    copyFile,
    lstat,
    mkdir,
    mkdtemp,
    readlink,
    rename,
    rm,
    symlink,
    unlink,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import type {
    OutcomeChangeEntry,
    OutcomePathFingerprint,
    OutcomePathState,
    RunOutcome,
} from './contracts.js';
import type { OutcomeStore } from './store.js';
import { assertSafeOutcomePath } from './validation.js';

export interface OutcomeWorkspaceTargets {
    primary: string;
    named?: Record<string, string>;
}

interface ApplyOperation {
    root: string;
    entry: OutcomeChangeEntry;
    destination: string;
    current?: OutcomePathFingerprint;
    skip: boolean;
}

export class OutcomeApplier {
    constructor(private readonly store: OutcomeStore) {}

    async apply(
        outcome: RunOutcome,
        targets: OutcomeWorkspaceTargets
    ): Promise<{ applied: number; unchanged: number }> {
        return this.store.withApplicationLease(outcome.id, () =>
            this.applyExclusive(outcome, targets)
        );
    }

    private async applyExclusive(
        outcome: RunOutcome,
        targets: OutcomeWorkspaceTargets
    ): Promise<{ applied: number; unchanged: number }> {
        const receipt = await this.store.receipt(outcome.id);
        if (receipt.state === 'present') {
            throw new Error('Outcome changes are already present in the workspace');
        }
        const operations: ApplyOperation[] = [];
        const conflicts: string[] = [];
        for (const changeset of outcome.changesets) {
            const root = resolveWorkspace(changeset.workspace, targets);
            await validateRoot(root);
            for (const entry of changeset.entries) {
                const path = assertSafeOutcomePath(entry.path);
                await validateDestination(root, path);
                const destination = join(root, path);
                const current = await fingerprint(destination, root, path);
                const alreadyApplied = sameState(current, entry.after);
                const canApply = matchesExpectedBefore(current, entry);
                if (!alreadyApplied && (!canApply || receipt.state === 'applied')) {
                    conflicts.push(
                        changeset.workspace.kind === 'primary'
                            ? path
                            : `${changeset.workspace.name}:${path}`
                    );
                }
                operations.push({
                    root,
                    entry,
                    destination,
                    ...(current ? { current } : {}),
                    skip: alreadyApplied,
                });
            }
        }
        if (conflicts.length > 0) {
            throw new Error(
                `Outcome conflicts with current workspace content: ${conflicts.join(', ')}`
            );
        }

        const transaction = await mkdtemp(join(tmpdir(), 'workbench-outcome-apply-'));
        const backups = new Map<string, string>();
        const applied: ApplyOperation[] = [];
        let preserveBackups = false;
        try {
            await writeFile(
                join(transaction, 'recovery.json'),
                JSON.stringify({
                    outcome_id: outcome.id,
                    operations: operations.map((operation, index) => ({
                        destination: operation.destination,
                        before: operation.current ?? null,
                        backup:
                            operation.current?.kind === 'file'
                                ? `backups/${index}`
                                : null,
                    })),
                }),
                { mode: 0o600, flag: 'wx' }
            );
            for (const [index, operation] of operations.entries()) {
                if (operation.skip) continue;
                await assertUnchanged(operation);
                if (operation.current?.kind === 'file') {
                    const backup = join(transaction, 'backups', String(index));
                    await copyCurrent(
                        operation.destination,
                        backup,
                        operation.current,
                        dirname(backup)
                    );
                    backups.set(operation.destination, backup);
                }
                await this.install(operation);
                applied.push(operation);
            }
            for (const operation of operations) {
                await assertInstalled(operation);
            }
            // Receipt persistence belongs to the transaction: a failed write
            // must leave the caller's workspace at its original content.
            await this.store.markApplied(outcome.id);
        } catch (error) {
            const rollbackFailures: unknown[] = [];
            for (const operation of applied.toReversed()) {
                await this.rollback(
                    operation,
                    backups.get(operation.destination)
                ).catch((cause) => rollbackFailures.push(cause));
            }
            if (rollbackFailures.length) {
                preserveBackups = true;
                throw new AggregateError(
                    [error, ...rollbackFailures],
                    `Outcome application failed and could not fully roll back. Recovery backups remain at ${transaction}`
                );
            }
            throw error;
        } finally {
            if (!preserveBackups)
                await rm(transaction, { recursive: true, force: true });
        }
        return {
            applied: applied.length,
            unchanged: operations.length - applied.length,
        };
    }

    private async install(operation: ApplyOperation): Promise<void> {
        await validateDestination(operation.root, operation.entry.path);
        if (operation.entry.operation === 'delete') {
            await assertUnchanged(operation);
            await unlink(operation.destination).catch((error) => {
                if (!isNodeError(error, 'ENOENT')) throw error;
            });
            return;
        }
        const after = operation.entry.after as OutcomePathState;
        await mkdir(dirname(operation.destination), { recursive: true, mode: 0o755 });
        const temporary = `${operation.destination}.workbench-${randomBytes(6).toString('hex')}.tmp`;
        try {
            if (after.kind === 'file') {
                await copyFile(await this.store.blob(after.content), temporary);
                await chmod(temporary, after.mode);
            } else {
                validateSymlinkTarget(
                    dirname(operation.destination),
                    after.target,
                    operation.root,
                    operation.entry.path
                );
                await symlink(after.target, temporary);
            }
            await assertUnchanged(operation);
            await rename(temporary, operation.destination);
        } finally {
            await rm(temporary, { force: true });
        }
    }

    private async rollback(
        operation: ApplyOperation,
        backup: string | undefined
    ): Promise<void> {
        await assertInstalled(operation);
        if (!operation.current) {
            await rm(operation.destination, { force: true });
            return;
        }
        if (operation.current.kind === 'file' && !backup) {
            throw new Error(
                `Outcome rollback content is missing: ${operation.entry.path}`
            );
        }
        const temporary = `${operation.destination}.workbench-${randomBytes(6).toString('hex')}.rollback`;
        try {
            await copyCurrent(
                backup ?? operation.destination,
                temporary,
                operation.current,
                operation.root
            );
            await assertInstalled(operation);
            await rename(temporary, operation.destination);
        } finally {
            await rm(temporary, { force: true });
        }
    }
}

async function assertUnchanged(operation: ApplyOperation): Promise<void> {
    await validateRoot(operation.root);
    await validateDestination(operation.root, operation.entry.path);
    const current = await fingerprint(
        operation.destination,
        operation.root,
        operation.entry.path
    );
    if (!sameFingerprint(current, operation.current)) {
        throw new Error(
            `Workspace changed during outcome application: ${operation.entry.path}`
        );
    }
}

async function assertInstalled(operation: ApplyOperation): Promise<void> {
    await validateRoot(operation.root);
    await validateDestination(operation.root, operation.entry.path);
    const current = await fingerprint(
        operation.destination,
        operation.root,
        operation.entry.path
    );
    if (!sameState(current, operation.entry.after)) {
        throw new Error(
            `Workspace changed after outcome installation: ${operation.entry.path}`
        );
    }
}

function resolveWorkspace(
    workspace: RunOutcome['changesets'][number]['workspace'],
    targets: OutcomeWorkspaceTargets
): string {
    if (workspace.kind === 'primary') return resolve(targets.primary);
    const target = targets.named?.[workspace.name];
    if (!target) {
        throw new Error(`Outcome requires named workspace: ${workspace.name}`);
    }
    return resolve(target);
}

async function validateRoot(root: string): Promise<void> {
    const details = await lstat(root).catch(() => undefined);
    if (!details || details.isSymbolicLink() || !details.isDirectory()) {
        throw new Error(`Outcome workspace is unavailable or unsafe: ${root}`);
    }
}

async function validateDestination(root: string, path: string): Promise<void> {
    assertSafeOutcomePath(path);
    let parent = root;
    for (const segment of path.split('/').slice(0, -1)) {
        parent = join(parent, segment);
        const details = await lstat(parent).catch((error) => {
            if (isNodeError(error, 'ENOENT')) return undefined;
            throw error;
        });
        if (!details) return;
        if (details.isSymbolicLink() || !details.isDirectory()) {
            throw new Error(
                `Outcome destination has an unsafe parent: ${join(root, path)}`
            );
        }
    }
}

async function fingerprint(
    path: string,
    root: string,
    displayPath: string
): Promise<OutcomePathFingerprint | undefined> {
    const details = await lstat(path).catch((error) => {
        if (isNodeError(error, 'ENOENT')) return undefined;
        throw error;
    });
    if (!details) return undefined;
    if (details.isSymbolicLink()) {
        const target = await readlink(path);
        validateSymlinkTarget(dirname(path), target, root, displayPath);
        return { kind: 'symlink', mode: details.mode & 0o777, target };
    }
    if (!details.isFile()) {
        throw new Error(`Outcome destination is not a file: ${displayPath}`);
    }
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    return {
        kind: 'file',
        digest: `sha256:${hash.digest('hex')}`,
        mode: details.mode & 0o777,
        size_bytes: details.size,
    };
}

function matchesExpectedBefore(
    current: OutcomePathFingerprint | undefined,
    entry: OutcomeChangeEntry
): boolean {
    if (entry.operation === 'add') return current === undefined;
    return sameFingerprint(current, entry.before);
}

function sameState(
    current: OutcomePathFingerprint | undefined,
    after: OutcomePathState | undefined
): boolean {
    if (!after) return current === undefined;
    if (!current || current.kind !== after.kind || current.mode !== after.mode) {
        return false;
    }
    return current.kind === 'file' && after.kind === 'file'
        ? current.digest === after.content.digest &&
              current.size_bytes === after.content.size_bytes
        : current.kind === 'symlink' && after.kind === 'symlink'
          ? current.target === after.target
          : false;
}

function sameFingerprint(
    left: OutcomePathFingerprint | undefined,
    right: OutcomePathFingerprint | undefined
): boolean {
    if (!left || !right) return left === right;
    if (left.kind !== right.kind || left.mode !== right.mode) {
        return false;
    }
    return left.kind === 'file' && right.kind === 'file'
        ? left.digest === right.digest && left.size_bytes === right.size_bytes
        : left.kind === 'symlink' && right.kind === 'symlink'
          ? left.target === right.target
          : false;
}

async function copyCurrent(
    source: string,
    destination: string,
    state: OutcomePathFingerprint,
    root: string
): Promise<void> {
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    if (state.kind === 'file') {
        await copyFile(source, destination);
        await chmod(destination, state.mode);
        return;
    }
    validateSymlinkTarget(dirname(destination), state.target, root, destination);
    await symlink(state.target, destination);
}

function validateSymlinkTarget(
    parent: string,
    target: string,
    root: string,
    displayPath: string
): void {
    if (isAbsolute(target) || !contains(root, resolve(parent, target))) {
        throw new Error(`Escaping symlink is not allowed in outcome: ${displayPath}`);
    }
}

function contains(parent: string, child: string): boolean {
    const suffix = relative(resolve(parent), resolve(child));
    return (
        suffix === '' ||
        (!suffix.startsWith(`..${sep}`) && suffix !== '..' && !isAbsolute(suffix))
    );
}

function isNodeError(error: unknown, code: string): boolean {
    return (
        error instanceof Error &&
        'code' in error &&
        (error as NodeJS.ErrnoException).code === code
    );
}
