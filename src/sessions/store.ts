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
import { join, resolve } from 'node:path';

import type { CatalogRegistryReference } from '../catalog/index.js';
import type { RepositoryBinding } from '../repositories/contracts.js';
import { RunStore } from '../runs/store.js';
import type { WorkbenchWorkspaceBinding } from '../types.js';
import { SessionIdentity } from './identity.js';

export interface StoredSession {
    version: 1;
    id: string;
    name?: string;
    workbench: string;
    workbench_version: string;
    runner: string;
    model: string;
    runtime: string;
    reference: string;
    workbench_path: string;
    source_workbench_path?: string;
    workbench_digest?: string;
    workspace: string;
    repository?: RepositoryBinding;
    workspaces: WorkbenchWorkspaceBinding[];
    registry?: CatalogRegistryReference;
    native_session_id?: string;
    latest_run_id: string;
    created_at: string;
    updated_at: string;
}

export type CreateStoredSessionOptions = Omit<
    StoredSession,
    'version' | 'name' | 'runtime' | 'created_at' | 'updated_at'
> & {
    name?: string;
    runtime?: string;
};

export class SessionStore {
    readonly #identity = new SessionIdentity();

    constructor(private readonly home: string) {}

    async exclusive<T>(id: string, operation: () => Promise<T>): Promise<T> {
        RunStore.validateId(id);
        const token = crypto.randomUUID();
        const directory = this.continuationLeaseDirectory(id);
        await this.acquireLease(
            directory,
            token,
            `Timed out waiting to continue Workbench session: ${id}`
        );
        try {
            return await operation();
        } finally {
            await this.releaseLease(directory, token);
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
        const { name, ...metadata } = options;
        const session: StoredSession = {
            version: 1,
            ...metadata,
            ...(name !== undefined ? { name: this.#identity.normalize(name) } : {}),
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
            (value.name !== undefined &&
                (typeof value.name !== 'string' ||
                    !this.#identity.isNormalized(value.name))) ||
            typeof value.workbench !== 'string' ||
            typeof value.workbench_version !== 'string' ||
            typeof value.runner !== 'string' ||
            typeof value.model !== 'string' ||
            typeof runtime !== 'string' ||
            runtime.length === 0 ||
            typeof value.reference !== 'string' ||
            typeof value.workbench_path !== 'string' ||
            (value.source_workbench_path !== undefined &&
                typeof value.source_workbench_path !== 'string') ||
            (value.workbench_digest !== undefined &&
                (typeof value.workbench_digest !== 'string' ||
                    !/^sha256:[0-9a-f]{64}$/.test(value.workbench_digest))) ||
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
        return this.mutate(id, (current) => ({
            ...current,
            ...patch,
            updated_at: new Date().toISOString(),
        }));
    }

    async rename(id: string, name: string): Promise<StoredSession> {
        const normalized = this.#identity.normalize(name);
        return this.mutate(id, (current) => ({
            ...current,
            name: normalized,
            updated_at: new Date().toISOString(),
        }));
    }

    async nameFromPrompt(id: string, prompt: string): Promise<StoredSession> {
        const suggested = this.#identity.fromPrompt(prompt);
        if (!suggested) return this.read(id);
        return this.mutate(id, (current) =>
            current.name
                ? current
                : {
                      ...current,
                      name: suggested,
                      updated_at: new Date().toISOString(),
                  }
        );
    }

    async list(
        options: { resumableOnly?: boolean; workspace?: string } = {}
    ): Promise<StoredSession[]> {
        const entries = await readdir(this.root, { withFileTypes: true }).catch(
            () => []
        );
        const workspace = options.workspace ? resolve(options.workspace) : undefined;
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
            .filter((session) => !workspace || resolve(session.workspace) === workspace)
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

    private continuationLeaseDirectory(id: string): string {
        return join(this.directory(id), '.lease');
    }

    private metadataLeaseDirectory(id: string): string {
        return join(this.directory(id), '.metadata-lease');
    }

    private leaseOwnerPath(directory: string): string {
        return join(directory, 'owner.json');
    }

    private async mutate(
        id: string,
        operation: (current: StoredSession) => StoredSession
    ): Promise<StoredSession> {
        RunStore.validateId(id);
        await this.read(id);
        const directory = this.metadataLeaseDirectory(id);
        const token = crypto.randomUUID();
        await this.acquireLease(
            directory,
            token,
            `Timed out updating Workbench session: ${id}`
        );
        try {
            const next = operation(await this.read(id));
            await this.write(next);
            return next;
        } finally {
            await this.releaseLease(directory, token);
        }
    }

    private async acquireLease(
        directory: string,
        token: string,
        timeoutMessage: string
    ): Promise<void> {
        const started = Date.now();
        while (Date.now() - started < 30_000) {
            try {
                await mkdir(directory, { mode: 0o700 });
                try {
                    await writeFile(
                        this.leaseOwnerPath(directory),
                        `${JSON.stringify({ version: 1, token, pid: process.pid })}\n`,
                        { mode: 0o600 }
                    );
                } catch (error) {
                    await rm(directory, {
                        recursive: true,
                        force: true,
                    });
                    throw error;
                }
                return;
            } catch (error) {
                if (!isAlreadyExists(error)) throw error;
                if (await this.recoverAbandonedLease(directory)) continue;
                await Bun.sleep(25);
            }
        }
        throw new Error(timeoutMessage);
    }

    private async recoverAbandonedLease(directory: string): Promise<boolean> {
        const source = await readFile(this.leaseOwnerPath(directory), 'utf8').catch(
            () => undefined
        );
        if (source) {
            try {
                const owner = JSON.parse(source) as { pid?: unknown };
                if (typeof owner.pid === 'number' && processIsAlive(owner.pid)) {
                    return false;
                }
                await rm(directory, { recursive: true, force: true });
                return true;
            } catch {
                // A partially written owner is handled by the age check below.
            }
        }
        const details = await stat(directory).catch(() => undefined);
        if (!details || Date.now() - details.mtimeMs < 5_000) return false;
        await rm(directory, { recursive: true, force: true });
        return true;
    }

    private async releaseLease(directory: string, token: string): Promise<void> {
        const source = await readFile(this.leaseOwnerPath(directory), 'utf8').catch(
            () => undefined
        );
        if (!source) return;
        try {
            const owner = JSON.parse(source) as { token?: unknown };
            if (owner.token !== token) return;
        } catch {
            return;
        }
        await rm(directory, { recursive: true, force: true });
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
