import { lstat, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

const identifier = /^wb_[a-z0-9]{20,64}$/;

/**
 * Every set of bytes the engine keeps for sessions and runs lives under
 * `<home>/files`. Rows in the database refer to these locations; nothing else
 * builds paths for session or run storage.
 *
 * Frozen package snapshots are content addressed and shared, so they stay in
 * the catalog store at `<home>/packages/<digest>` rather than being copied per
 * session.
 */
export class WorkbenchFiles {
    constructor(readonly home: string) {}

    get root(): string {
        return join(this.home, 'files');
    }

    /** The runner's own state directory for one session. */
    nativeDirectory(sessionId: string): string {
        return join(this.root, 'native', this.identifier(sessionId, 'session'));
    }

    /** Parent of the managed checkout and agent Git state for one session. */
    repositoryParent(sessionId: string): string {
        return join(this.root, 'repositories', this.identifier(sessionId, 'session'));
    }

    checkoutDirectory(sessionId: string): string {
        return join(this.repositoryParent(sessionId), 'repository');
    }

    agentGitDirectory(sessionId: string): string {
        return join(this.repositoryParent(sessionId), 'agent-git');
    }

    /** Scratch space that exists only while a run is live. */
    workDirectory(runId: string): string {
        return join(this.root, 'work', this.identifier(runId, 'run'));
    }

    outboxDirectory(runId: string): string {
        return join(this.workDirectory(runId), 'outbox');
    }

    /** Root of a shared, content-addressed package snapshot. */
    packageRoot(digest: string): string {
        return join(this.home, 'packages', digest.slice('sha256:'.length));
    }

    async sessionBytes(sessionId: string): Promise<number> {
        const sizes = await Promise.all([
            this.bytes(this.nativeDirectory(sessionId)),
            this.bytes(this.repositoryParent(sessionId)),
        ]);
        return sizes.reduce((total, size) => total + size, 0);
    }

    runBytes(runId: string): Promise<number> {
        return this.bytes(this.workDirectory(runId));
    }

    async removeSession(sessionId: string): Promise<void> {
        await rm(this.nativeDirectory(sessionId), { recursive: true, force: true });
        await rm(this.repositoryParent(sessionId), { recursive: true, force: true });
    }

    async removeWork(runId: string): Promise<void> {
        await rm(this.workDirectory(runId), { recursive: true, force: true });
    }

    private identifier(id: string, label: string): string {
        if (!identifier.test(id)) throw new Error(`Invalid ${label} ID: ${id}`);
        return id;
    }

    private async bytes(path: string): Promise<number> {
        const details = await lstat(path).catch(() => undefined);
        if (!details) return 0;
        if (!details.isDirectory()) return details.size;
        const entries = await readdir(path).catch(() => []);
        const sizes = await Promise.all(
            entries.map((entry) => this.bytes(join(path, entry)))
        );
        return sizes.reduce((total, size) => total + size, 0);
    }
}
