import { createHash, randomBytes } from 'node:crypto';
import {
    appendFile,
    lstat,
    mkdir,
    open,
    readdir,
    readFile,
    rename,
    rm,
    stat,
    writeFile,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { CatalogRegistryReference } from '../catalog/index.js';
import { OutcomeStore } from '../outcomes/store.js';
import type { WorkbenchWorkspaceBinding } from '../types.js';
import { RunControl } from './control.js';
import type { WorkbenchEvent } from './events.js';
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
}

export interface StoredRunRequest {
    version: 1;
    workbench_path: string;
    workspace: string;
    task: string;
    workspaces?: WorkbenchWorkspaceBinding[];
    allow_host_docker?: boolean;
    reference?: string;
    session_id?: string;
    native_session_id?: string;
    connection?: string;
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
    constructor(private readonly home: string) {}

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
        if (run.pid && !this.processAlive(run.pid)) {
            throw new Error(`Workbench run worker exited unexpectedly: ${run.id}`);
        }
    }

    async reconcile(run: StoredRun, now = Date.now()): Promise<StoredRun> {
        if (RunStore.isTerminal(run.status)) return run;
        return new RunReconciliationLease(run.id, this.directory(run.id)).exclusive(
            async () => {
                const current = await this.read(run.id);
                if (RunStore.isTerminal(current.status)) return current;
                const dispatchedAt = Date.parse(current.dispatched_at);
                const waitingForWorker =
                    !current.pid &&
                    Number.isFinite(dispatchedAt) &&
                    now - dispatchedAt < 30_000;
                if (
                    waitingForWorker ||
                    (current.pid && this.processAlive(current.pid))
                ) {
                    return current;
                }
                const events = await this.readEvents(current.id);
                const last = events.at(-1);
                if (last && terminalEventTypes.has(last.type)) {
                    return this.update(current.id, this.terminalState(last));
                }
                await this.appendEvent(current.id, {
                    protocol: 0,
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
            }
        );
    }

    async create(options: CreateStoredRunOptions): Promise<StoredRun> {
        const id = options.id ?? RunStore.createId();
        RunStore.validateId(id);
        const directory = this.directory(id);
        if (await stat(directory).catch(() => null)) {
            throw new Error(`Run already exists: ${id}`);
        }
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const metadata: StoredRun = {
            version: 1,
            id,
            status: 'dispatched',
            dispatched_at: new Date().toISOString(),
            ...options.metadata,
        };
        await Promise.all([
            this.writeJson(this.metadataPath(id), metadata),
            this.writeJson(this.requestPath(id), {
                version: 1,
                ...options.request,
            } satisfies StoredRunRequest),
            writeFile(this.eventsPath(id), '', { mode: 0o600 }),
            new RunControl(this.home, id).initialize(),
        ]);
        return metadata;
    }

    async read(id: string): Promise<StoredRun> {
        RunStore.validateId(id);
        const source = await readFile(this.metadataPath(id), 'utf8').catch(() => null);
        if (!source) throw new Error(`Workbench run does not exist: ${id}`);
        const value = JSON.parse(source) as Partial<StoredRun>;
        if (
            value.version !== 1 ||
            value.id !== id ||
            typeof value.status !== 'string' ||
            typeof value.workbench !== 'string' ||
            typeof value.dispatched_at !== 'string'
        ) {
            throw new Error(`Invalid Workbench run record: ${id}`);
        }
        return value as StoredRun;
    }

    async update(
        id: string,
        patch: Partial<Omit<StoredRun, 'version' | 'id'>>
    ): Promise<StoredRun> {
        const current = await this.read(id);
        const next: StoredRun = { ...current, ...patch };
        await this.writeJson(this.metadataPath(id), next);
        return next;
    }

    async takeRequest(id: string): Promise<StoredRunRequest> {
        RunStore.validateId(id);
        const path = this.requestPath(id);
        const source = await readFile(path, 'utf8').catch(() => null);
        if (!source) throw new Error(`Workbench run request is unavailable: ${id}`);
        const value = JSON.parse(source) as Partial<StoredRunRequest>;
        if (
            value.version !== 1 ||
            typeof value.workbench_path !== 'string' ||
            typeof value.workspace !== 'string' ||
            typeof value.task !== 'string' ||
            (value.connection !== undefined && typeof value.connection !== 'string')
        ) {
            throw new Error(`Invalid Workbench run request: ${id}`);
        }
        await rm(path, { force: true });
        return value as StoredRunRequest;
    }

    async appendEvent(id: string, event: WorkbenchEvent): Promise<void> {
        RunStore.validateId(id);
        await appendFile(this.eventsPath(id), `${JSON.stringify(event)}\n`, {
            mode: 0o600,
        });
    }

    async readEvents(id: string): Promise<WorkbenchEvent[]> {
        RunStore.validateId(id);
        await this.read(id);
        const source = await readFile(this.eventsPath(id), 'utf8');
        return source
            .split('\n')
            .filter(Boolean)
            .map((line) => this.parseEvent(line, id));
    }

    async latest(): Promise<StoredRun> {
        const latest = (await this.list())[0];
        if (!latest) throw new Error('No Workbench runs have been dispatched');
        return latest;
    }

    async *follow(
        id: string,
        options: {
            pollMilliseconds?: number;
            afterSequence?: number;
            signal?: AbortSignal;
        } = {}
    ): AsyncGenerator<WorkbenchEvent> {
        RunStore.validateId(id);
        await this.read(id);
        const path = this.eventsPath(id);
        let offset = 0;
        let pending = '';
        const decoder = new TextDecoder();
        const pollMilliseconds = options.pollMilliseconds ?? 100;
        const afterSequence = options.afterSequence ?? 0;

        const readAvailable = async (): Promise<WorkbenchEvent[]> => {
            const details = await stat(path).catch(() => null);
            if (!details || details.size <= offset) return [];
            const handle = await open(path, 'r');
            try {
                const bytes = new Uint8Array(details.size - offset);
                const result = await handle.read(bytes, 0, bytes.length, offset);
                offset += result.bytesRead;
                pending += decoder.decode(bytes.subarray(0, result.bytesRead), {
                    stream: true,
                });
            } finally {
                await handle.close();
            }
            const lines = pending.split('\n');
            pending = lines.pop() ?? '';
            return lines
                .filter(Boolean)
                .map((line) => this.parseEvent(line, id))
                .filter((event) => event.sequence > afterSequence);
        };

        while (!options.signal?.aborted) {
            for (const event of await readAvailable()) yield event;

            const run = await this.read(id);
            if (RunStore.isTerminal(run.status)) {
                for (const event of await readAvailable()) yield event;
                if (pending.trim()) {
                    const event = this.parseEvent(pending, id);
                    if (event.sequence > afterSequence) yield event;
                }
                return;
            }
            this.assertWorkerAlive(run);
            await this.delay(pollMilliseconds, options.signal);
        }
    }

    async list(): Promise<StoredRun[]> {
        const root = join(this.home, 'runs');
        const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
        const runs = await Promise.all(
            entries
                .filter((entry) => entry.isDirectory() && entry.name.startsWith('wb_'))
                .map((entry) => this.read(entry.name).catch(() => null))
        );
        return runs
            .filter((run): run is StoredRun => run !== null)
            .toSorted((left, right) =>
                right.dispatched_at.localeCompare(left.dispatched_at)
            );
    }

    async size(id: string): Promise<number> {
        await this.read(id);
        const outcomes = new OutcomeStore(this.home);
        const metadata = await Promise.all(
            (await outcomes.listByRun(id)).map((outcome) =>
                outcomes.metadataSize(outcome.id)
            )
        );
        return (
            (await this.directorySize(this.directory(id))) +
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
        await rm(this.directory(id), { recursive: true, force: true });
    }

    private directory(id: string): string {
        return join(this.home, 'runs', id);
    }

    private metadataPath(id: string): string {
        return join(this.directory(id), 'run.json');
    }

    private requestPath(id: string): string {
        return join(this.directory(id), 'request.json');
    }

    private eventsPath(id: string): string {
        return join(this.directory(id), 'events.ndjson');
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

    private async writeJson(path: string, value: unknown): Promise<void> {
        const temporary = `${path}.${crypto.randomUUID()}.tmp`;
        await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
            mode: 0o600,
        });
        await rename(temporary, path);
    }

    private parseEvent(line: string, id: string): WorkbenchEvent {
        try {
            const event = JSON.parse(line) as Partial<WorkbenchEvent>;
            if (event.run_id !== id || typeof event.type !== 'string') {
                throw new Error();
            }
            return event as WorkbenchEvent;
        } catch {
            throw new Error(`Invalid event stream for Workbench run: ${id}`);
        }
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

    private processAlive(pid: number): boolean {
        try {
            process.kill(pid, 0);
            return true;
        } catch {
            return false;
        }
    }

    private delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
        if (signal?.aborted) return Promise.resolve();
        return new Promise((resolve) => {
            const finish = () => {
                clearTimeout(timer);
                signal?.removeEventListener('abort', finish);
                resolve();
            };
            const timer = setTimeout(finish, milliseconds);
            signal?.addEventListener('abort', finish, { once: true });
        });
    }
}
