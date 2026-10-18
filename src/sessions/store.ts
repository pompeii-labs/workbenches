import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { CatalogRegistryReference } from '../catalog/types.js';
import { RepositoryCheckoutStore } from '../database/checkouts.js';
import type { Connection } from '../database/connection.js';
import { LeaseStore } from '../database/leases.js';
import { type Row, RowReader } from '../database/rows.js';
import { SessionRecordStore } from '../database/sessions.js';
import { WorkbenchFiles } from '../files/layout.js';
import type { ProcessProbe } from '../processes/probe.js';
import {
    isRepositoryBinding,
    type RepositoryBinding,
} from '../repositories/contracts.js';
import { isStoredRegistry, isStoredWorkspaces } from '../runs/bindings.js';
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
    /** The original run accepted a GPU requirement the runtime cannot verify. */
    allow_unchecked_gpu?: boolean;
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
    readonly #files: WorkbenchFiles;
    readonly #leases: LeaseStore;
    readonly #records: SessionRecordStore;

    constructor(
        private readonly database: Pick<
            Connection,
            'run' | 'one' | 'all' | 'transaction'
        >,
        home: string,
        probe: Pick<ProcessProbe, 'alive'>
    ) {
        this.#files = new WorkbenchFiles(home);
        this.#leases = new LeaseStore(database, probe);
        this.#records = new SessionRecordStore(
            database,
            new RepositoryCheckoutStore(database)
        );
    }

    async exclusive<T>(id: string, operation: () => Promise<T>): Promise<T> {
        RunStore.validateId(id);
        return this.#leases.exclusive(
            `session:${id}`,
            {
                timeoutMilliseconds: 30_000,
                pollMilliseconds: 25,
                timeoutMessage: `Timed out waiting to continue Workbench session: ${id}`,
            },
            operation
        );
    }

    async create(options: CreateStoredSessionOptions): Promise<StoredSession> {
        RunStore.validateId(options.id);
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
        const native = this.nativeDirectory(session.id);
        const inserted = this.#records.insert([
            session.id,
            session.name ?? null,
            session.workbench,
            session.workbench_version,
            session.runner,
            session.model,
            session.runtime,
            session.reference,
            session.workbench_path,
            session.source_workbench_path ?? null,
            session.workbench_digest ?? null,
            session.workspace,
            session.repository ? JSON.stringify(session.repository) : null,
            JSON.stringify(session.workspaces),
            session.registry ? JSON.stringify(session.registry) : null,
            session.allow_unchecked_gpu === undefined
                ? null
                : Number(session.allow_unchecked_gpu),
            native,
            session.native_session_id ?? null,
            session.latest_run_id,
            session.created_at,
            session.updated_at,
        ]);
        if (!inserted) throw new Error(`Session already exists: ${session.id}`);
        try {
            await mkdir(native, { recursive: true, mode: 0o700 });
        } catch (error) {
            this.#records.discard(session.id);
            throw error;
        }
        return session;
    }

    async read(id: string): Promise<StoredSession> {
        return this.load(id);
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
        const workspace = options.workspace ? resolve(options.workspace) : undefined;
        return this.#records
            .rows()
            .flatMap((row) => {
                try {
                    return [this.parse(row)];
                } catch {
                    return [];
                }
            })
            .filter(
                (session) =>
                    !options.resumableOnly || Boolean(session.native_session_id)
            )
            .filter(
                (session) => !workspace || resolve(session.workspace) === workspace
            );
    }

    async remove(id: string): Promise<void> {
        RunStore.validateId(id);
        this.#records.remove(id);
        await this.#files.removeSession(id);
    }

    async size(id: string): Promise<number> {
        await this.read(id);
        return this.#files.sessionBytes(id);
    }

    nativeDirectory(id: string): string {
        RunStore.validateId(id);
        return this.#files.nativeDirectory(id);
    }

    private load(id: string): StoredSession {
        RunStore.validateId(id);
        const row = this.#records.row(id);
        if (!row) throw new Error(`Workbench session does not exist: ${id}`);
        return this.parse(row);
    }

    private parse(row: Row): StoredSession {
        const reader = new RowReader(row, 'Workbench session record');
        const name = reader.optionalText('name');
        const digest = reader.optionalText('workbench_digest');
        if (name !== undefined && !this.#identity.isNormalized(name))
            throw new Error('Invalid Workbench session record: column name');
        if (digest !== undefined && !/^sha256:[0-9a-f]{64}$/.test(digest))
            throw new Error(
                'Invalid Workbench session record: column workbench_digest'
            );
        const repository = reader.optionalJson('repository', isRepositoryBinding);
        const registry = reader.optionalJson('registry', isStoredRegistry);
        const gpu = reader.optionalFlag('allow_unchecked_gpu');
        const native = reader.optionalText('native_session_id');
        const source = reader.optionalText('source_workbench_path');
        return {
            version: 1,
            id: reader.text('id'),
            ...(name !== undefined ? { name } : {}),
            workbench: reader.text('workbench'),
            workbench_version: reader.text('workbench_version'),
            runner: reader.text('runner'),
            model: reader.text('model'),
            runtime: reader.text('runtime'),
            reference: reader.text('reference'),
            workbench_path: reader.text('workbench_path'),
            ...(source !== undefined ? { source_workbench_path: source } : {}),
            ...(digest !== undefined ? { workbench_digest: digest } : {}),
            workspace: reader.text('workspace'),
            ...(repository ? { repository } : {}),
            workspaces: reader.json('workspaces', isStoredWorkspaces),
            ...(registry ? { registry } : {}),
            ...(gpu !== undefined ? { allow_unchecked_gpu: gpu } : {}),
            ...(native !== undefined ? { native_session_id: native } : {}),
            latest_run_id: reader.text('latest_run_id'),
            created_at: reader.text('created_at'),
            updated_at: reader.text('updated_at'),
        };
    }

    private async mutate(
        id: string,
        operation: (current: StoredSession) => StoredSession
    ): Promise<StoredSession> {
        RunStore.validateId(id);
        return this.database.transaction(() => {
            const next = operation(this.load(id));
            this.#records.change(id, {
                name: next.name ?? null,
                native_session_id: next.native_session_id ?? null,
                latest_run_id: next.latest_run_id,
                updated_at: next.updated_at,
            });
            return next;
        });
    }
}
