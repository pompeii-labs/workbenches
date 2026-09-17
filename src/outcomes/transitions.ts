import { randomBytes } from 'node:crypto';
import {
    chmod,
    copyFile,
    link,
    lstat,
    mkdir,
    readdir,
    rename,
    rm,
    rmdir,
    symlink,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { OutcomeChangeEntry, OutcomePathFingerprint } from './contracts.js';
import {
    fingerprint,
    sameFingerprint,
    sameState,
    validateDestination,
    validateRoot,
} from './fingerprints.js';
import type { OutcomeStore } from './store.js';

/** Owns a file/directory replacement as one rollback unit, including its original tree. */
export class OutcomeTransition {
    readonly destination: string;
    readonly backup: string;
    private readonly temporary: string;
    private moved = false;
    private installed = false;
    private reservation: { dev: number; ino: number } | undefined;
    skip = false;

    private constructor(
        private readonly root: string,
        readonly anchor: OutcomeChangeEntry,
        readonly entries: OutcomeChangeEntry[]
    ) {
        this.destination = join(root, anchor.path);
        const token = randomBytes(6).toString('hex');
        this.backup = `${this.destination}.workbench-${token}.backup`;
        this.temporary = `${this.destination}.workbench-${token}.tmp`;
    }

    static plan(root: string, entries: OutcomeChangeEntry[]): OutcomeTransition[] {
        const transitions: OutcomeTransition[] = [];
        const claimed = new Set<OutcomeChangeEntry>();
        for (const anchor of entries) {
            if (claimed.has(anchor) || anchor.operation === 'modify') continue;
            const children = entries.filter((entry) =>
                entry.path.startsWith(`${anchor.path}/`)
            );
            if (!children.length) continue;
            const childOperation = anchor.operation === 'delete' ? 'add' : 'delete';
            if (
                children.some(
                    (entry) => claimed.has(entry) || entry.operation !== childOperation
                )
            )
                throw new Error(`Invalid outcome directory transition: ${anchor.path}`);
            const family = [anchor, ...children];
            for (const entry of family) claimed.add(entry);
            transitions.push(new OutcomeTransition(root, anchor, family));
        }
        return transitions;
    }

    async preflight(applied: boolean): Promise<void> {
        if (await this.matches('after')) {
            this.skip = true;
            return;
        }
        if (applied || !(await this.matches('before')))
            throw new Error(
                `Outcome conflicts with current workspace content: ${this.anchor.path}`
            );
    }

    async install(store: OutcomeStore): Promise<void> {
        await this.assertBefore();
        try {
            if (this.anchor.operation === 'delete') {
                await mkdir(this.temporary, { mode: 0o755 });
                for (const entry of this.entries.slice(1)) {
                    const path = join(
                        this.temporary,
                        entry.path.slice(this.anchor.path.length + 1)
                    );
                    await mkdir(dirname(path), { recursive: true, mode: 0o755 });
                    await this.materialize(store, entry, path);
                }
            } else await this.materialize(store, this.anchor, this.temporary);
            await this.assertBefore();
            await rename(this.destination, this.backup);
            this.moved = true;
            // Inspect the object actually moved, not just the earlier live path.
            await this.assertOriginal();
            if (this.anchor.operation === 'delete') {
                // Claim an absent directory. Rename may replace only this empty
                // reservation; any newly written child makes the rename fail.
                await this.reserveDirectory();
                await rename(this.temporary, this.destination);
                this.reservation = undefined;
            } else {
                // Unlike rename, link cannot overwrite a destination recreated
                // after its original content moved into the recovery backup.
                await link(this.temporary, this.destination);
            }
            this.installed = true;
        } finally {
            await this.releaseReservation();
            await rm(this.temporary, { recursive: true, force: true });
        }
    }

    async assertInstalled(): Promise<void> {
        if (this.moved) await this.assertOriginal();
        if (!(await this.matches('after')))
            throw new Error(
                `Workspace changed after outcome installation: ${this.anchor.path}`
            );
    }

    async rollback(): Promise<void> {
        if (!this.moved) return;
        if (this.installed) {
            await this.assertInstalled();
            await rename(this.destination, this.temporary);
        } else if (await lstat(this.destination).catch(() => undefined)) {
            throw new Error(
                `Workspace changed during outcome application: ${this.anchor.path}`
            );
        }
        try {
            await rename(this.backup, this.destination);
            this.moved = false;
            this.installed = false;
        } catch (error) {
            if (this.installed) await rename(this.temporary, this.destination);
            throw error;
        } finally {
            await rm(this.temporary, { recursive: true, force: true });
        }
    }

    async cleanup(): Promise<void> {
        if (!this.moved) return;
        await this.assertOriginal();
        await rm(this.backup, { recursive: true, force: true });
        this.moved = false;
    }

    private async assertOriginal(): Promise<void> {
        if (!(await this.matches('before', this.backup)))
            throw new Error(
                `Workspace changed during outcome application: ${this.anchor.path}`
            );
    }

    private async releaseReservation(): Promise<void> {
        const reservation = this.reservation;
        if (!reservation) return;
        const current = await lstat(this.destination).catch(() => undefined);
        if (current?.dev === reservation.dev && current.ino === reservation.ino) {
            await rmdir(this.destination).catch((error) => {
                if (
                    error instanceof Error &&
                    'code' in error &&
                    ['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(String(error.code))
                )
                    return;
                throw error;
            });
        }
        this.reservation = undefined;
    }

    private async reserveDirectory(): Promise<void> {
        await mkdir(this.destination, { mode: 0o755 });
        this.reservation = await lstat(this.destination);
    }

    private async assertBefore(): Promise<void> {
        if (!(await this.matches('before')))
            throw new Error(
                `Workspace changed during outcome application: ${this.anchor.path}`
            );
    }

    private async matches(
        side: 'before' | 'after',
        destination = this.destination
    ): Promise<boolean> {
        await validateRoot(this.root);
        await validateDestination(this.root, this.anchor.path);
        const directory = (this.anchor.operation === 'delete') === (side === 'after');
        const details = await lstat(destination).catch((error) => {
            if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
                return undefined;
            throw error;
        });
        if (!details) return false;
        if (!directory) {
            if (details.isDirectory()) return false;
            const current = await fingerprint(destination, this.root, this.anchor.path);
            return side === 'before'
                ? sameFingerprint(current, this.anchor.before)
                : sameState(current, this.anchor.after);
        }
        if (!details.isDirectory() || details.isSymbolicLink()) return false;
        const actual = new Map<string, OutcomePathFingerprint>();
        const directories = new Set<string>();
        const expected = this.entries.slice(1);
        const expectedDirectories = new Set<string>();
        for (const entry of expected) {
            let parent = dirname(entry.path);
            while (parent !== this.anchor.path) {
                expectedDirectories.add(parent);
                parent = dirname(parent);
            }
        }
        const walk = async (path: string, physical: string): Promise<void> => {
            for (const name of await readdir(physical)) {
                const child = `${path}/${name}`;
                const childPhysical = join(physical, name);
                const stat = await lstat(childPhysical);
                if (stat.isDirectory() && !stat.isSymbolicLink()) {
                    directories.add(child);
                    await walk(child, childPhysical);
                } else {
                    const value = await fingerprint(childPhysical, this.root, child);
                    if (value) actual.set(child, value);
                }
            }
        };
        await walk(this.anchor.path, destination);
        return (
            directories.size === expectedDirectories.size &&
            [...directories].every((path) => expectedDirectories.has(path)) &&
            actual.size === expected.length &&
            expected.every((entry) =>
                side === 'before'
                    ? sameFingerprint(actual.get(entry.path), entry.before)
                    : sameState(actual.get(entry.path), entry.after)
            )
        );
    }

    private async materialize(
        store: OutcomeStore,
        entry: OutcomeChangeEntry,
        path: string
    ): Promise<void> {
        const after = entry.after;
        if (!after)
            throw new Error(`Missing outcome transition content: ${entry.path}`);
        if (after.kind === 'symlink') await symlink(after.target, path);
        else {
            await copyFile(await store.blob(after.content), path);
            await chmod(path, after.mode);
        }
    }
}
