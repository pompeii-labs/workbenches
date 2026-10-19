import { createHash, randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import type { CatalogRegistryReference } from '../catalog/types.js';
import type { Connection } from '../database/connection.js';
import { LeaseStore } from '../database/leases.js';
import { type Row, RowReader } from '../database/rows.js';
import { RunEventStore } from '../database/runs/events.js';
import { type RunColumns, RunRecordStore } from '../database/runs/records.js';
import { RunRequestStore, type StoredRunRequest } from '../database/runs/requests.js';
import { WorkbenchFiles } from '../files/layout.js';
import { OutcomeStore } from '../outcomes/store.js';
import type { ProcessProbe } from '../processes/probe.js';
import {
    isRepositoryBinding,
    type RepositoryBinding,
} from '../repositories/contracts.js';
import type { WorkbenchWorkspaceBinding } from '../types.js';
import { isStoredRegistry, isStoredWorkspaces } from './bindings.js';
import { WORKBENCH_EVENT_PROTOCOL, type WorkbenchEvent } from './events.js';
import { RunReconciliationLease } from './reconciliation.js';

export type StoredRunStatus =
    | 'dispatched'
    | 'running'
    | 'completed'
    | 'failed'
    | 'cancelled';

export interface StoredRun {
    version: 1;
    id: string;
    status: StoredRunStatus;
    workbench: string;
    workbench_version: string;
    runner: string;
    model: string;
    runtime?: string;
    workspace: string;
    repository?: RepositoryBinding;
    mode?: 'foreground' | 'detached' | 'interactive';
    execution?: 'one_shot' | 'session';
    workspaces?: WorkbenchWorkspaceBinding[];
    allow_host_docker?: boolean;
    registry?: CatalogRegistryReference;
    registry_event_id?: string;
    dispatched_at: string;
    started_at?: string;
    finished_at?: string;
    pid?: number;
    runner_session_id?: string;
    session_id?: string;
    resumed_from?: string;
    exit_code?: number;
    outcome_id?: string;
    /** The task the run was started with, kept for local history. */
    task?: string;
}

/** Told the id of every run whose record or events this store changes. */
export interface RunChangeListener {
    notify(runId: string): void;
}

const terminalStatuses = new Set<StoredRunStatus>(['completed', 'failed', 'cancelled']);
const terminalEventTypes = new Set<WorkbenchEvent['type']>([
    'run.completed',
    'run.failed',
    'run.cancelled',
]);

export interface CreateStoredRunOptions {
    metadata: Omit<StoredRun, 'version' | 'id' | 'status' | 'dispatched_at'>;
    request: Omit<StoredRunRequest, 'version'>;
    id?: string;
}

export class RunStore {
    readonly #events: RunEventStore;
    readonly #records: RunRecordStore;
    readonly #requests: RunRequestStore;
    readonly #leases: LeaseStore;
    readonly #files: WorkbenchFiles;

    constructor(
        private readonly database: Pick<
            Connection,
            'run' | 'one' | 'all' | 'transaction' | 'changeToken' | 'delay'
        >,
        private readonly home: string,
        private readonly probe: Pick<ProcessProbe, 'alive'>,
        private readonly changes: RunChangeListener
    ) {
        this.#events = new RunEventStore(database);
        this.#records = new RunRecordStore(database);
        this.#requests = new RunRequestStore(database);
        this.#leases = new LeaseStore(database, probe);
        this.#files = new WorkbenchFiles(home);
    }

    static createId(): string {
        return `wb_${Date.now().toString(36)}${randomBytes(10).toString('hex')}`;
    }

    static scope(home: string): string {
        return createHash('sha256').update(resolve(home)).digest('hex').slice(0, 24);
    }

    static validateId(id: string): void {
        if (!/^wb_[a-z0-9]{20,64}$/.test(id)) {
            throw new Error(`Invalid run ID: ${id}`);
        }
    }

    static isTerminal(status: StoredRunStatus): boolean {
        return terminalStatuses.has(status);
    }

    assertWorkerAlive(run: StoredRun): void {
        if (run.pid && !this.probe.alive(run.pid)) {
            throw new Error(`Workbench run worker exited unexpectedly: ${run.id}`);
        }
    }

    async reconcile(run: StoredRun, now = Date.now()): Promise<StoredRun> {
        if (RunStore.isTerminal(run.status)) return run;
        return new RunReconciliationLease(run.id, this.#leases).exclusive(async () => {
            const current = await this.read(run.id);
            if (RunStore.isTerminal(current.status)) return current;
            const dispatchedAt = Date.parse(current.dispatched_at);
            const waitingForWorker =
                !current.pid &&
                Number.isFinite(dispatchedAt) &&
                now - dispatchedAt < 30_000;
            if (waitingForWorker || (current.pid && this.probe.alive(current.pid))) {
                return current;
            }
            const last = this.#events.last(current.id);
            if (last && terminalEventTypes.has(last.type)) {
                return this.update(current.id, this.terminalState(last));
            }
            await this.appendEvent(current.id, {
                protocol: WORKBENCH_EVENT_PROTOCOL,
                run_id: current.id,
                sequence: (last?.sequence ?? 0) + 1,
                timestamp: new Date(now).toISOString(),
                type: 'run.failed',
                runner: current.runner,
                data: { message: 'Workbench run worker exited unexpectedly' },
            });
            return this.update(current.id, {
                status: 'failed',
                exit_code: 1,
                finished_at: new Date(now).toISOString(),
            });
        });
    }

    async create(options: CreateStoredRunOptions): Promise<StoredRun> {
        const id = options.id ?? RunStore.createId();
        RunStore.validateId(id);
        const run: StoredRun = {
            version: 1,
            id,
            status: 'dispatched',
            dispatched_at: new Date().toISOString(),
            ...options.metadata,
        };
        this.database.transaction(() => {
            if (!this.#records.insert(this.columns(run)))
                throw new Error(`Run already exists: ${id}`);
            this.#requests.put(id, { version: 1, ...options.request });
        });
        return run;
    }

    async read(id: string): Promise<StoredRun> {
        RunStore.validateId(id);
        const row = this.#records.row(id);
        if (!row) throw new Error(`Workbench run does not exist: ${id}`);
        return this.parse(row, id);
    }

    async update(
        id: string,
        patch: Partial<Omit<StoredRun, 'version' | 'id'>>
    ): Promise<StoredRun> {
        RunStore.validateId(id);
        const next = this.database.transaction(() => {
            const current = this.parse(this.#records.row(id) ?? this.missing(id), id);
            const next: StoredRun = { ...current, ...patch };
            this.#records.replace(this.columns(next));
            return next;
        });
        this.changes.notify(id);
        return next;
    }

    async takeRequest(id: string): Promise<StoredRunRequest> {
        RunStore.validateId(id);
        return this.#requests.take(id);
    }

    async appendEvent(id: string, event: WorkbenchEvent): Promise<void> {
        RunStore.validateId(id);
        this.#events.append(id, event);
        this.changes.notify(id);
    }

    async readEvents(id: string): Promise<WorkbenchEvent[]> {
        RunStore.validateId(id);
        await this.read(id);
        return this.#events.read(id);
    }

    async latest(): Promise<StoredRun> {
        const latest = (await this.list())[0];
        if (!latest) throw new Error('No Workbench runs have been dispatched');
        return latest;
    }

    /**
     * Yields events as they are committed. Between polls it compares the
     * database's change signal and reads nothing when no one has written.
     */
    async *follow(
        id: string,
        options: {
            pollMilliseconds?: number;
            afterSequence?: number;
            signal?: AbortSignal;
        } = {}
    ): AsyncGenerator<WorkbenchEvent> {
        RunStore.validateId(id);
        let run = await this.read(id);
        const pollMilliseconds = options.pollMilliseconds ?? 100;
        const afterSequence = options.afterSequence ?? 0;
        let cursor = 0;
        let seen = '';

        const drain = (): WorkbenchEvent[] => {
            const logged = this.#events.after(id, cursor);
            const last = logged.at(-1);
            if (last) cursor = last.cursor;
            return logged
                .map((entry) => entry.event)
                .filter((event) => event.sequence > afterSequence);
        };

        while (!options.signal?.aborted) {
            const token = this.database.changeToken();
            if (token !== seen) {
                seen = token;
                for (const event of drain()) yield event;
                run = await this.read(id);
                if (RunStore.isTerminal(run.status)) {
                    for (const event of drain()) yield event;
                    return;
                }
            }
            this.assertWorkerAlive(run);
            await this.database.delay(pollMilliseconds, options.signal);
        }
    }

    async list(): Promise<StoredRun[]> {
        return this.#records.rows().flatMap((row) => {
            try {
                return [this.parse(row, String(row.id))];
            } catch {
                return [];
            }
        });
    }

    async size(id: string): Promise<number> {
        const run = await this.read(id);
        const outcomes = new OutcomeStore(this.home);
        const metadata = await Promise.all(
            (await outcomes.listByRun(id)).map((outcome) =>
                outcomes.metadataSize(outcome.id)
            )
        );
        return (
            Buffer.byteLength(JSON.stringify(run)) +
            (await this.#files.runBytes(id)) +
            this.#events.bytes(id) +
            metadata.reduce((sum, bytes) => sum + bytes, 0)
        );
    }

    async removeTerminal(id: string): Promise<void> {
        const run = await this.read(id);
        if (!RunStore.isTerminal(run.status)) {
            throw new Error(`Active Workbench run cannot be removed: ${id}`);
        }
        const outcomes = new OutcomeStore(this.home);
        for (const outcome of await outcomes.list()) {
            if (outcome.run_id === id) await outcomes.remove(outcome.id);
        }
        this.#records.remove(id);
        await this.#files.removeWork(id);
    }

    private missing(id: string): never {
        throw new Error(`Workbench run does not exist: ${id}`);
    }

    private columns(run: StoredRun): RunColumns {
        return [
            run.id,
            run.status,
            run.workbench,
            run.workbench_version,
            run.runner,
            run.model,
            run.runtime ?? null,
            run.workspace,
            run.repository ? JSON.stringify(run.repository) : null,
            run.mode ?? null,
            run.execution ?? null,
            run.workspaces ? JSON.stringify(run.workspaces) : null,
            run.allow_host_docker === undefined ? null : Number(run.allow_host_docker),
            run.registry ? JSON.stringify(run.registry) : null,
            run.registry_event_id ?? null,
            run.dispatched_at,
            run.started_at ?? null,
            run.finished_at ?? null,
            run.pid ?? null,
            run.runner_session_id ?? null,
            run.session_id ?? null,
            run.resumed_from ?? null,
            run.exit_code ?? null,
            run.outcome_id ?? null,
            run.task ?? null,
        ] as const;
    }

    private parse(row: Row, id: string): StoredRun {
        const reader = new RowReader(row, 'Workbench run record');
        const status = reader.text('status');
        if (
            status !== 'dispatched' &&
            status !== 'running' &&
            status !== 'completed' &&
            status !== 'failed' &&
            status !== 'cancelled'
        )
            throw new Error(`Invalid Workbench run record: ${id}`);
        const mode = reader.optionalText('mode');
        const execution = reader.optionalText('execution');
        if (
            (mode !== undefined &&
                mode !== 'foreground' &&
                mode !== 'detached' &&
                mode !== 'interactive') ||
            (execution !== undefined &&
                execution !== 'one_shot' &&
                execution !== 'session')
        )
            throw new Error(`Invalid Workbench run record: ${id}`);
        const repository = reader.optionalJson('repository', isRepositoryBinding);
        const workspaces = reader.optionalJson('workspaces', isStoredWorkspaces);
        const registry = reader.optionalJson('registry', isStoredRegistry);
        const optional = {
            runtime: reader.optionalText('runtime'),
            registry_event_id: reader.optionalText('registry_event_id'),
            started_at: reader.optionalText('started_at'),
            finished_at: reader.optionalText('finished_at'),
            pid: reader.optionalInteger('pid'),
            runner_session_id: reader.optionalText('runner_session_id'),
            session_id: reader.optionalText('session_id'),
            resumed_from: reader.optionalText('resumed_from'),
            exit_code: reader.optionalInteger('exit_code'),
            outcome_id: reader.optionalText('outcome_id'),
            task: reader.optionalText('task'),
            allow_host_docker: reader.optionalFlag('allow_host_docker'),
        };
        return {
            version: 1,
            id: reader.text('id'),
            status,
            workbench: reader.text('workbench'),
            workbench_version: reader.text('workbench_version'),
            runner: reader.text('runner'),
            model: reader.text('model'),
            ...(optional.runtime !== undefined ? { runtime: optional.runtime } : {}),
            workspace: reader.text('workspace'),
            ...(repository ? { repository } : {}),
            ...(mode ? { mode } : {}),
            ...(execution ? { execution } : {}),
            ...(workspaces ? { workspaces } : {}),
            ...(optional.allow_host_docker !== undefined
                ? { allow_host_docker: optional.allow_host_docker }
                : {}),
            ...(registry ? { registry } : {}),
            ...(optional.registry_event_id !== undefined
                ? { registry_event_id: optional.registry_event_id }
                : {}),
            dispatched_at: reader.text('dispatched_at'),
            ...(optional.started_at !== undefined
                ? { started_at: optional.started_at }
                : {}),
            ...(optional.finished_at !== undefined
                ? { finished_at: optional.finished_at }
                : {}),
            ...(optional.pid !== undefined ? { pid: optional.pid } : {}),
            ...(optional.runner_session_id !== undefined
                ? { runner_session_id: optional.runner_session_id }
                : {}),
            ...(optional.session_id !== undefined
                ? { session_id: optional.session_id }
                : {}),
            ...(optional.resumed_from !== undefined
                ? { resumed_from: optional.resumed_from }
                : {}),
            ...(optional.exit_code !== undefined
                ? { exit_code: optional.exit_code }
                : {}),
            ...(optional.outcome_id !== undefined
                ? { outcome_id: optional.outcome_id }
                : {}),
            ...(optional.task !== undefined ? { task: optional.task } : {}),
        };
    }

    private terminalState(
        event: WorkbenchEvent
    ): Pick<StoredRun, 'status' | 'exit_code' | 'finished_at'> {
        const exitCode =
            typeof event.data === 'object' &&
            event.data !== null &&
            typeof Reflect.get(event.data, 'exit_code') === 'number'
                ? Number(Reflect.get(event.data, 'exit_code'))
                : undefined;
        if (event.type === 'run.completed') {
            return {
                status: 'completed',
                exit_code: exitCode ?? 0,
                finished_at: event.timestamp,
            };
        }
        if (event.type === 'run.cancelled') {
            return {
                status: 'cancelled',
                exit_code: exitCode ?? 130,
                finished_at: event.timestamp,
            };
        }
        return {
            status: 'failed',
            exit_code: exitCode ?? 1,
            finished_at: event.timestamp,
        };
    }
}
