import { randomBytes } from 'node:crypto';
import {
    chmod,
    copyFile,
    mkdir,
    mkdtemp,
    rename,
    rm,
    symlink,
    unlink,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import type {
    OutcomeChangeEntry,
    OutcomePathFingerprint,
    OutcomePathState,
    RunOutcome,
} from './contracts.js';
import {
    fingerprint,
    sameFingerprint,
    sameState,
    validateDestination,
    validateRoot,
    validateSymlinkTarget,
} from './fingerprints.js';
import type { OutcomeStore } from './store.js';
import { validateFilesystemSymlink } from './symlinks.js';
import { OutcomeTransition } from './transitions.js';
import { assertSafeOutcomePath, parseRunOutcome } from './validation.js';

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
        outcome = parseRunOutcome(outcome);
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
        const transitions: OutcomeTransition[] = [];
        const conflicts: string[] = [];
        for (const changeset of outcome.changesets) {
            const root = resolveWorkspace(changeset.workspace, targets);
            await validateRoot(root);
            for (const entry of changeset.entries) {
                if (entry.after?.kind === 'symlink')
                    await validateFilesystemSymlink(
                        root,
                        entry.path,
                        entry.after.target,
                        changeset.entries
                    );
            }
            const replacements = OutcomeTransition.plan(root, changeset.entries);
            const replaced = new Set(
                replacements.flatMap((transition) => transition.entries)
            );
            for (const transition of replacements)
                await transition.preflight(receipt.state === 'applied');
            transitions.push(...replacements);
            for (const entry of changeset.entries) {
                if (replaced.has(entry)) continue;
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
        const appliedTransitions: OutcomeTransition[] = [];
        let preserveBackups = false;
        let failure: unknown;
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
                    transitions: transitions.map((transition) => ({
                        destination: transition.destination,
                        backup: transition.backup,
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
            for (const transition of transitions) {
                if (transition.skip) continue;
                appliedTransitions.push(transition);
                await transition.install(this.store);
            }
            for (const operation of operations) {
                await assertInstalled(operation);
            }
            for (const transition of transitions) await transition.assertInstalled();
            // Receipt persistence belongs to the transaction: a failed write
            // must leave the caller's workspace at its original content.
            await this.store.markApplied(outcome.id);
        } catch (error) {
            const rollbackFailures: unknown[] = [];
            for (const transition of appliedTransitions.toReversed())
                await transition
                    .rollback()
                    .catch((cause) => rollbackFailures.push(cause));
            for (const operation of applied.toReversed()) {
                await this.rollback(
                    operation,
                    backups.get(operation.destination)
                ).catch((cause) => rollbackFailures.push(cause));
            }
            if (rollbackFailures.length) {
                preserveBackups = true;
                failure = new AggregateError(
                    [error, ...rollbackFailures],
                    `Outcome application failed and could not fully roll back. Recovery backups remain at ${transaction}`
                );
            } else failure = error;
        } finally {
            if (!preserveBackups) {
                try {
                    await Promise.all(
                        transitions.map((transition) => transition.cleanup())
                    );
                } catch (error) {
                    preserveBackups = true;
                    failure = new AggregateError(
                        failure === undefined ? [error] : [failure, error],
                        `Outcome backup cleanup failed. Recovery backups remain at ${transaction}`
                    );
                }
                if (!preserveBackups)
                    await rm(transaction, { recursive: true, force: true });
            }
        }
        if (failure !== undefined) throw failure;
        return {
            applied:
                applied.length +
                appliedTransitions.reduce(
                    (sum, transition) => sum + transition.entries.length,
                    0
                ),
            unchanged:
                operations.length -
                applied.length +
                transitions
                    .filter((transition) => transition.skip)
                    .reduce((sum, transition) => sum + transition.entries.length, 0),
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

function matchesExpectedBefore(
    current: OutcomePathFingerprint | undefined,
    entry: OutcomeChangeEntry
): boolean {
    if (entry.operation === 'add') return current === undefined;
    return sameFingerprint(current, entry.before);
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

function isNodeError(error: unknown, code: string): boolean {
    return (
        error instanceof Error &&
        'code' in error &&
        (error as NodeJS.ErrnoException).code === code
    );
}
