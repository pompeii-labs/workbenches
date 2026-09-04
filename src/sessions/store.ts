import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
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
    'version' | 'created_at' | 'updated_at'
>;

export class SessionStore {
    constructor(private readonly home: string) {}

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
        if (
            value.version !== 1 ||
            value.id !== id ||
            typeof value.workbench !== 'string' ||
            typeof value.workbench_version !== 'string' ||
            typeof value.runner !== 'string' ||
            typeof value.model !== 'string' ||
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
        return value as StoredSession;
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

    private async write(session: StoredSession): Promise<void> {
        const path = this.metadataPath(session.id);
        await mkdir(this.directory(session.id), { recursive: true, mode: 0o700 });
        const temporary = `${path}.${crypto.randomUUID()}.tmp`;
        await writeFile(temporary, `${JSON.stringify(session, null, 2)}\n`, {
            mode: 0o600,
        });
        await rename(temporary, path);
    }
}
