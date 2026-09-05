import { randomBytes } from 'node:crypto';
import {
    appendFile,
    mkdir,
    open,
    readdir,
    readFile,
    rename,
    rm,
    stat,
    writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import type { CatalogRegistryReference } from '../catalog/index.js';
import type { WorkbenchWorkspaceBinding } from '../types.js';
import { RunControl } from './control.js';
import type { WorkbenchEvent } from './events.js';

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
        const dispatchedAt = Date.parse(run.dispatched_at);
        const waitingForWorker =
            !run.pid && Number.isFinite(dispatchedAt) && now - dispatchedAt < 30_000;
        if (waitingForWorker || (run.pid && this.processAlive(run.pid))) return run;
        const events = await this.readEvents(run.id);
        const last = events.at(-1);
        if (!last || !terminalEventTypes.has(last.type)) {
            await this.appendEvent(run.id, {
                protocol: 0,
                run_id: run.id,
                sequence: (last?.sequence ?? 0) + 1,
                timestamp: new Date(now).toISOString(),
                type: 'run.failed',
                runner: run.runner,
                data: { message: 'Workbench run worker exited unexpectedly' },
            });
        }
        return this.update(run.id, {
            status: 'failed',
            exit_code: 1,
            finished_at: new Date(now).toISOString(),
        });
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
            typeof value.task !== 'string'
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

        while (!options.signal?.aborted) {
            const details = await stat(path).catch(() => null);
            if (details && details.size > offset) {
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
                for (const line of lines) {
                    if (!line) continue;
                    const event = this.parseEvent(line, id);
                    if (event.sequence > afterSequence) yield event;
                }
            }

            const run = await this.read(id);
            if (RunStore.isTerminal(run.status)) {
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
