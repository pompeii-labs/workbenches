import {
    lstat,
    mkdir,
    readdir,
    readFile,
    rename,
    rm,
    stat,
    writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';

import type { CatalogRegistryReference } from '../catalog/index.js';
import { RunStore } from '../runs/store.js';
import type { WorkbenchWorkspaceBinding } from '../types.js';

export interface StoredSession {
    version: 1;
    id: string;
    workbench: string;
    workbench_version: string;
    runner: string;
    model: string;
    runtime: string;
    reference: string;
    workbench_path: string;
    workspace: string;
    workspaces: WorkbenchWorkspaceBinding[];
    registry?: CatalogRegistryReference;
    native_session_id?: string;
    latest_run_id: string;
    created_at: string;
    updated_at: string;
}

export type CreateStoredSessionOptions = Omit<
    StoredSession,
    'version' | 'runtime' | 'created_at' | 'updated_at'
> & {
    runtime?: string;
};

export class SessionStore {
    constructor(private readonly home: string) {}

    async exclusive<T>(id: string, operation: () => Promise<T>): Promise<T> {
        RunStore.validateId(id);
        const token = crypto.randomUUID();
        await this.acquire(id, token);
        try {
            return await operation();
        } finally {
            await this.release(id, token);
        }
    }

    async create(options: CreateStoredSessionOptions): Promise<StoredSession> {
        RunStore.validateId(options.id);
        if (await stat(this.directory(options.id)).catch(() => null)) {
            throw new Error(`Session already exists: ${options.id}`);
        }
        await mkdir(this.nativeDirectory(options.id), {
            recursive: true,
            mode: 0o700,
        });
        const timestamp = new Date().toISOString();
        const session: StoredSession = {
            version: 1,
            ...options,
            runtime: options.runtime ?? 'local',
            created_at: timestamp,
            updated_at: timestamp,
        };
        await this.write(session);
        return session;
    }

    async read(id: string): Promise<StoredSession> {
        RunStore.validateId(id);
        const source = await readFile(this.metadataPath(id), 'utf8').catch(() => null);
        if (!source) throw new Error(`Workbench session does not exist: ${id}`);
        const value = JSON.parse(source) as Partial<StoredSession>;
        const runtime = value.runtime ?? 'local';
        if (
            value.version !== 1 ||
            value.id !== id ||
            typeof value.workbench !== 'string' ||
            typeof value.workbench_version !== 'string' ||
            typeof value.runner !== 'string' ||
            typeof value.model !== 'string' ||
            typeof runtime !== 'string' ||
            runtime.length === 0 ||
            typeof value.reference !== 'string' ||
            typeof value.workbench_path !== 'string' ||
            typeof value.workspace !== 'string' ||
            !Array.isArray(value.workspaces) ||
            (value.native_session_id !== undefined &&
                typeof value.native_session_id !== 'string') ||
            typeof value.latest_run_id !== 'string' ||
            typeof value.created_at !== 'string' ||
            typeof value.updated_at !== 'string'
        ) {
            throw new Error(`Invalid Workbench session record: ${id}`);
        }
        return { ...value, runtime } as StoredSession;
    }

    async update(
        id: string,
        patch: Partial<Pick<StoredSession, 'native_session_id' | 'latest_run_id'>>
    ): Promise<StoredSession> {
        const current = await this.read(id);
        const next: StoredSession = {
            ...current,
            ...patch,
            updated_at: new Date().toISOString(),
        };
        await this.write(next);
        return next;
    }

    async list(options: { resumableOnly?: boolean } = {}): Promise<StoredSession[]> {
        const entries = await readdir(this.root, { withFileTypes: true }).catch(
            () => []
        );
        const sessions = await Promise.all(
            entries
                .filter((entry) => entry.isDirectory() && entry.name.startsWith('wb_'))
                .map((entry) => this.read(entry.name).catch(() => null))
        );
        return sessions
            .filter((session): session is StoredSession => session !== null)
            .filter(
                (session) =>
                    !options.resumableOnly || Boolean(session.native_session_id)
            )
            .toSorted((left, right) => right.updated_at.localeCompare(left.updated_at));
    }

    async remove(id: string): Promise<void> {
        RunStore.validateId(id);
        await rm(this.directory(id), { recursive: true, force: true });
    }

    async size(id: string): Promise<number> {
        await this.read(id);
        return this.directorySize(this.directory(id));
    }

    nativeDirectory(id: string): string {
        RunStore.validateId(id);
        return join(this.directory(id), 'native');
    }

    transcriptPath(id: string): string {
        RunStore.validateId(id);
        return join(this.directory(id), 'transcript.json');
    }

    private get root(): string {
        return join(this.home, 'sessions');
    }

    private directory(id: string): string {
        return join(this.root, id);
    }

    private metadataPath(id: string): string {
        return join(this.directory(id), 'session.json');
    }

    private leaseDirectory(id: string): string {
        return join(this.directory(id), '.lease');
    }

    private leaseOwnerPath(id: string): string {
        return join(this.leaseDirectory(id), 'owner.json');
    }

    private async acquire(id: string, token: string): Promise<void> {
        const started = Date.now();
        while (Date.now() - started < 30_000) {
            try {
                await mkdir(this.leaseDirectory(id), { mode: 0o700 });
                try {
                    await writeFile(
                        this.leaseOwnerPath(id),
                        `${JSON.stringify({ version: 1, token, pid: process.pid })}\n`,
                        { mode: 0o600 }
                    );
                } catch (error) {
                    await rm(this.leaseDirectory(id), {
                        recursive: true,
                        force: true,
                    });
                    throw error;
                }
                return;
            } catch (error) {
                if (!isAlreadyExists(error)) throw error;
                if (await this.recoverAbandonedLease(id)) continue;
                await Bun.sleep(25);
            }
        }
        throw new Error(`Timed out waiting to continue Workbench session: ${id}`);
    }

    private async recoverAbandonedLease(id: string): Promise<boolean> {
        const source = await readFile(this.leaseOwnerPath(id), 'utf8').catch(
            () => undefined
        );
        if (source) {
            try {
                const owner = JSON.parse(source) as { pid?: unknown };
                if (typeof owner.pid === 'number' && processIsAlive(owner.pid)) {
                    return false;
                }
                await rm(this.leaseDirectory(id), { recursive: true, force: true });
                return true;
            } catch {
                // A partially written owner is handled by the age check below.
            }
        }
        const details = await stat(this.leaseDirectory(id)).catch(() => undefined);
        if (!details || Date.now() - details.mtimeMs < 5_000) return false;
        await rm(this.leaseDirectory(id), { recursive: true, force: true });
        return true;
    }

    private async release(id: string, token: string): Promise<void> {
        const source = await readFile(this.leaseOwnerPath(id), 'utf8').catch(
            () => undefined
        );
        if (!source) return;
        try {
            const owner = JSON.parse(source) as { token?: unknown };
            if (owner.token !== token) return;
        } catch {
            return;
        }
        await rm(this.leaseDirectory(id), { recursive: true, force: true });
    }

    private async write(session: StoredSession): Promise<void> {
        const path = this.metadataPath(session.id);
        await mkdir(this.directory(session.id), { recursive: true, mode: 0o700 });
        const temporary = `${path}.${crypto.randomUUID()}.tmp`;
        await writeFile(temporary, `${JSON.stringify(session, null, 2)}\n`, {
            mode: 0o600,
        });
        await rename(temporary, path);
    }

    private async directorySize(path: string): Promise<number> {
        const details = await lstat(path).catch(() => undefined);
        if (!details) return 0;
        if (!details.isDirectory()) return details.size;
        const entries = await readdir(path).catch(() => []);
        const sizes = await Promise.all(
            entries.map((entry) => this.directorySize(join(path, entry)))
        );
        return sizes.reduce((total, size) => total + size, 0);
    }
}

function processIsAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

function isAlreadyExists(error: unknown): boolean {
    return (
        error instanceof Error &&
        'code' in error &&
        (error as NodeJS.ErrnoException).code === 'EEXIST'
    );
}
