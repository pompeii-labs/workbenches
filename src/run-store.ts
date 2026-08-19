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

import type { WorkbenchEvent } from './execution.js';

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
    mode?: 'foreground' | 'detached';
    dispatched_at: string;
    started_at?: string;
    finished_at?: string;
    pid?: number;
    exit_code?: number;
}

export interface StoredRunRequest {
    version: 1;
    workbench_path: string;
    workspace: string;
    task: string;
}

const terminalStatuses = new Set<StoredRunStatus>(['completed', 'failed', 'cancelled']);

export function createRunId(): string {
    return `wb_${Date.now().toString(36)}${randomBytes(10).toString('hex')}`;
}

export function validateRunId(id: string): void {
    if (!/^wb_[a-z0-9]{20,64}$/.test(id)) throw new Error(`Invalid run ID: ${id}`);
}

export async function createStoredRun(options: {
    home: string;
    metadata: Omit<StoredRun, 'version' | 'id' | 'status' | 'dispatched_at'>;
    request: Omit<StoredRunRequest, 'version'>;
    id?: string;
}): Promise<StoredRun> {
    const id = options.id ?? createRunId();
    validateRunId(id);
    const directory = runDirectory(options.home, id);
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
        writeJson(metadataPath(options.home, id), metadata),
        writeJson(requestPath(options.home, id), {
            version: 1,
            ...options.request,
        } satisfies StoredRunRequest),
        writeFile(eventsPath(options.home, id), '', { mode: 0o600 }),
    ]);
    return metadata;
}

export async function readStoredRun(home: string, id: string): Promise<StoredRun> {
    validateRunId(id);
    const source = await readFile(metadataPath(home, id), 'utf8').catch(() => null);
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

export async function updateStoredRun(
    home: string,
    id: string,
    patch: Partial<Omit<StoredRun, 'version' | 'id'>>
): Promise<StoredRun> {
    const current = await readStoredRun(home, id);
    const next: StoredRun = { ...current, ...patch };
    await writeJson(metadataPath(home, id), next);
    return next;
}

export async function takeStoredRunRequest(
    home: string,
    id: string
): Promise<StoredRunRequest> {
    validateRunId(id);
    const path = requestPath(home, id);
    const source = await readFile(path, 'utf8').catch(() => null);
    if (!source) throw new Error(`Detached run request is unavailable: ${id}`);
    const value = JSON.parse(source) as Partial<StoredRunRequest>;
    if (
        value.version !== 1 ||
        typeof value.workbench_path !== 'string' ||
        typeof value.workspace !== 'string' ||
        typeof value.task !== 'string'
    ) {
        throw new Error(`Invalid detached run request: ${id}`);
    }
    await rm(path, { force: true });
    return value as StoredRunRequest;
}

export async function appendRunEvent(
    home: string,
    id: string,
    event: WorkbenchEvent
): Promise<void> {
    validateRunId(id);
    await appendFile(eventsPath(home, id), `${JSON.stringify(event)}\n`, {
        mode: 0o600,
    });
}

export async function latestStoredRun(home: string): Promise<StoredRun> {
    const latest = (await storedRuns(home)).toSorted((left, right) =>
        right.dispatched_at.localeCompare(left.dispatched_at)
    )[0];
    if (!latest) throw new Error('No Workbench runs have been dispatched');
    return latest;
}

export async function latestActiveDetachedRun(home: string): Promise<StoredRun> {
    const latest = (await storedRuns(home))
        .filter((run) => run.mode === 'detached' && !terminalStatuses.has(run.status))
        .toSorted((left, right) =>
            right.dispatched_at.localeCompare(left.dispatched_at)
        )[0];
    if (!latest) throw new Error('No active detached Workbench runs');
    return latest;
}

export async function requestStoredRunCancellation(
    home: string,
    id: string
): Promise<void> {
    const run = await readStoredRun(home, id);
    if (run.mode !== 'detached') {
        throw new Error(`Workbench run is not a detached run: ${id}`);
    }
    if (terminalStatuses.has(run.status)) {
        throw new Error(`Workbench run is already ${run.status}: ${id}`);
    }
    await writeFile(cancellationPath(home, id), 'cancel\n', {
        mode: 0o600,
    });
}

export function watchStoredRunCancellation(
    home: string,
    id: string,
    cancel: () => void,
    options: { pollMilliseconds?: number } = {}
): () => void {
    validateRunId(id);
    let stopped = false;
    let checking = false;
    const check = async () => {
        if (stopped || checking) return;
        checking = true;
        try {
            if (await stat(cancellationPath(home, id)).catch(() => null)) cancel();
        } finally {
            checking = false;
        }
    };
    void check();
    const timer = setInterval(() => void check(), options.pollMilliseconds ?? 100);
    return () => {
        stopped = true;
        clearInterval(timer);
    };
}

export async function clearStoredRunCancellation(
    home: string,
    id: string
): Promise<void> {
    validateRunId(id);
    await rm(cancellationPath(home, id), { force: true });
}

export async function* followRunEvents(
    home: string,
    id: string,
    options: { pollMilliseconds?: number } = {}
): AsyncGenerator<WorkbenchEvent> {
    validateRunId(id);
    await readStoredRun(home, id);
    const path = eventsPath(home, id);
    let offset = 0;
    let pending = '';
    const decoder = new TextDecoder();
    const pollMilliseconds = options.pollMilliseconds ?? 100;

    while (true) {
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
                yield parseEvent(line, id);
            }
        }

        const run = await readStoredRun(home, id);
        if (terminalStatuses.has(run.status)) {
            if (pending.trim()) yield parseEvent(pending, id);
            return;
        }
        if (run.pid && !processAlive(run.pid)) {
            throw new Error(`Workbench run worker exited unexpectedly: ${id}`);
        }
        await delay(pollMilliseconds);
    }
}

export function isTerminalStatus(status: StoredRunStatus): boolean {
    return terminalStatuses.has(status);
}

function runDirectory(home: string, id: string): string {
    return join(home, 'runs', id);
}

function metadataPath(home: string, id: string): string {
    return join(runDirectory(home, id), 'run.json');
}

function requestPath(home: string, id: string): string {
    return join(runDirectory(home, id), 'request.json');
}

function eventsPath(home: string, id: string): string {
    return join(runDirectory(home, id), 'events.ndjson');
}

function cancellationPath(home: string, id: string): string {
    return join(runDirectory(home, id), 'cancel');
}

async function storedRuns(home: string): Promise<StoredRun[]> {
    const root = join(home, 'runs');
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    const runs = await Promise.all(
        entries
            .filter((entry) => entry.isDirectory() && entry.name.startsWith('wb_'))
            .map((entry) => readStoredRun(home, entry.name).catch(() => null))
    );
    return runs.filter((run): run is StoredRun => run !== null);
}

async function writeJson(path: string, value: unknown): Promise<void> {
    const temporary = `${path}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
        mode: 0o600,
    });
    await rename(temporary, path);
}

function parseEvent(line: string, id: string): WorkbenchEvent {
    try {
        const event = JSON.parse(line) as Partial<WorkbenchEvent>;
        if (event.run_id !== id || typeof event.type !== 'string') throw new Error();
        return event as WorkbenchEvent;
    } catch {
        throw new Error(`Invalid event stream for Workbench run: ${id}`);
    }
}

function processAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

function delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
