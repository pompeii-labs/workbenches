import { RowReader } from '../database/rows.js';
import type { RegistryAccount } from '../registry/account-store.js';
import type { RegistryClient } from '../registry/client.js';

export type ProjectColumn = 'needs_you' | 'running' | 'done' | 'failed';

export interface CloudProjectActivity {
    task_id: string;
    latest_run_id: string;
    title: string;
    workbench: string;
    source: 'cloud';
    text: string;
    at: string;
}

export interface CloudProjectWaiting {
    task_id: string;
    latest_run_id: string;
    title: string;
    text: string;
    at: string;
}

export interface CloudProject {
    name: string;
    slug: string;
    counts: Record<ProjectColumn, number>;
    updated_at: string;
    now: CloudProjectActivity[];
    waiting: CloudProjectWaiting[];
    latest_done: {
        task_id: string;
        latest_run_id: string;
        title: string;
        at: string;
        has_outcome: boolean;
    } | null;
    today: { runs: number; tokens: number; cost_usd: number | null };
}

export interface CloudProjectTask {
    id: string;
    project: { name: string; slug: string };
    source: 'cloud';
    title: string;
    workbench: { name: string; version: string };
    status: string;
    column: ProjectColumn;
    latest_run_id: string;
    needs_input: boolean;
    created_at: string;
    updated_at: string;
}

export type CloudProjectFrame =
    | { type: 'task'; task: CloudProjectTask }
    | { type: 'project'; project: CloudProject };

export class CloudProjectsUnsupportedError extends Error {
    constructor() {
        super('The Workbench cloud does not support projects');
        this.name = 'CloudProjectsUnsupportedError';
    }
}

export class CloudProjectClient {
    constructor(private readonly client: Pick<RegistryClient, 'apiUrl'>) {}

    async create(
        account: RegistryAccount,
        name: string
    ): Promise<{ project?: CloudProject; conflict: boolean; message?: string }> {
        const response = await this.fetch(account, '/v1/projects', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name }),
        });
        const value: unknown = await response.json().catch(() => null);
        if (response.status === 404 || response.status === 405)
            throw new CloudProjectsUnsupportedError();
        if (response.status === 409)
            return { conflict: true, message: errorMessage(value, response.status) };
        if (!response.ok) throw new Error(errorMessage(value, response.status));
        return { project: parseCloudProject(value), conflict: false };
    }

    async list(account: RegistryAccount): Promise<CloudProject[]> {
        const value = await this.request(account, '/v1/projects');
        if (!isRecord(value) || !Array.isArray(value.projects))
            return malformed('projects');
        return value.projects.map(parseCloudProject);
    }

    async tasks(account: RegistryAccount, slug: string): Promise<CloudProjectTask[]> {
        const value = await this.request(
            account,
            `/v1/projects/${encodeURIComponent(slug)}/tasks`
        );
        if (!isRecord(value) || !Array.isArray(value.tasks)) return malformed('tasks');
        return value.tasks.map(parseCloudProjectTask);
    }

    subscribe(
        account: RegistryAccount,
        handlers: {
            frame: (frame: CloudProjectFrame) => void;
            close: (code: number) => void;
            error: () => void;
        }
    ): WebSocket {
        const url = new URL('/v1/realtime', this.client.apiUrl);
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
        const socket = new WebSocket(url, {
            headers: { Authorization: `Bearer ${account.token}` },
        });
        socket.addEventListener('message', (message) => {
            try {
                const frame = parseCloudProjectFrame(JSON.parse(String(message.data)));
                if (frame) handlers.frame(frame);
            } catch {
                handlers.error();
                socket.close();
            }
        });
        socket.addEventListener('close', (close) => handlers.close(close.code));
        socket.addEventListener('error', handlers.error);
        return socket;
    }

    private async request(account: RegistryAccount, path: string): Promise<unknown> {
        const response = await this.fetch(account, path);
        const value: unknown = await response.json().catch(() => null);
        if (response.status === 404 || response.status === 405)
            throw new CloudProjectsUnsupportedError();
        if (!response.ok) throw new Error(errorMessage(value, response.status));
        return value;
    }

    private fetch(
        account: RegistryAccount,
        path: string,
        options: RequestInit = {}
    ): Promise<Response> {
        return fetch(new URL(path, this.client.apiUrl), {
            ...options,
            headers: {
                Accept: 'application/json',
                Authorization: `Bearer ${account.token}`,
                ...options.headers,
            },
            signal: options.signal ?? AbortSignal.timeout(20_000),
        });
    }
}

export function parseCloudProject(value: unknown): CloudProject {
    if (!isRecord(value) || !isRecord(value.counts) || !isRecord(value.today))
        return malformed('project');
    const latest = value.latest_done;
    if (
        typeof value.name !== 'string' ||
        typeof value.slug !== 'string' ||
        typeof value.updated_at !== 'string' ||
        !Array.isArray(value.now) ||
        !Array.isArray(value.waiting) ||
        (latest !== null && !isRecord(latest))
    )
        return malformed('project');
    return {
        name: value.name,
        slug: value.slug,
        counts: parseCounts(value.counts),
        updated_at: value.updated_at,
        now: value.now.map(parseActivity),
        waiting: value.waiting.map(parseWaiting),
        latest_done: latest === null ? null : parseLatestDone(latest),
        today: parseToday(value.today),
    };
}

export function parseCloudProjectTask(value: unknown): CloudProjectTask {
    if (!isRecord(value) || !isRecord(value.project) || !isRecord(value.workbench))
        return malformed('project task');
    if (
        !textFields(value, [
            'id',
            'title',
            'status',
            'column',
            'latest_run_id',
            'created_at',
            'updated_at',
        ]) ||
        !textFields(value.project, ['name', 'slug']) ||
        !textFields(value.workbench, ['name', 'version']) ||
        value.source !== 'cloud' ||
        typeof value.needs_input !== 'boolean' ||
        !column(value.column)
    )
        return malformed('project task');
    return {
        id: value.id,
        project: { name: value.project.name, slug: value.project.slug },
        source: 'cloud',
        title: value.title,
        workbench: { name: value.workbench.name, version: value.workbench.version },
        status: value.status,
        column: value.column,
        latest_run_id: value.latest_run_id,
        needs_input: value.needs_input,
        created_at: value.created_at,
        updated_at: value.updated_at,
    };
}

// The realtime socket carries every topic in the organization. Frames this client
// does not understand are dropped (undefined); known frames must be well formed.
function parseCloudProjectFrame(value: unknown): CloudProjectFrame | undefined {
    if (!isRecord(value)) return malformed('project frame');
    if (value.type !== 'task' && value.type !== 'project') return undefined;
    if (typeof value.topic !== 'string' || !value.topic.startsWith('project:'))
        return undefined;
    const slug = value.topic.slice('project:'.length);
    if (value.type === 'task') {
        const task = parseCloudProjectTask(value.task);
        if (task.project.slug !== slug) return malformed('project frame');
        return { type: 'task', task };
    }
    const project = parseCloudProject(value.project);
    if (project.slug !== slug) return malformed('project frame');
    return { type: 'project', project };
}

function parseCounts(value: Record<string, unknown>): Record<ProjectColumn, number> {
    return {
        needs_you: integer(value.needs_you),
        running: integer(value.running),
        done: integer(value.done),
        failed: integer(value.failed),
    };
}

function parseActivity(value: unknown): CloudProjectActivity {
    if (
        !isRecord(value) ||
        !textFields(value, [
            'task_id',
            'latest_run_id',
            'title',
            'workbench',
            'text',
            'at',
        ]) ||
        value.source !== 'cloud'
    )
        return malformed('project activity');
    return {
        task_id: value.task_id,
        latest_run_id: value.latest_run_id,
        title: value.title,
        workbench: value.workbench,
        source: 'cloud',
        text: value.text,
        at: value.at,
    };
}

function parseWaiting(value: unknown): CloudProjectWaiting {
    if (
        !isRecord(value) ||
        !textFields(value, ['task_id', 'latest_run_id', 'title', 'text', 'at'])
    )
        return malformed('project waiting');
    return {
        task_id: value.task_id,
        latest_run_id: value.latest_run_id,
        title: value.title,
        text: value.text,
        at: value.at,
    };
}

function parseLatestDone(
    value: Record<string, unknown>
): NonNullable<CloudProject['latest_done']> {
    if (
        !textFields(value, ['task_id', 'latest_run_id', 'title', 'at']) ||
        typeof value.has_outcome !== 'boolean'
    )
        return malformed('project completion');
    return {
        task_id: value.task_id,
        latest_run_id: value.latest_run_id,
        title: value.title,
        at: value.at,
        has_outcome: value.has_outcome,
    };
}

function parseToday(value: Record<string, unknown>): CloudProject['today'] {
    if (value.cost_usd !== null && !number(value.cost_usd))
        return malformed('project totals');
    return {
        runs: integer(value.runs),
        tokens: integer(value.tokens),
        cost_usd: value.cost_usd,
    };
}

function integer(value: unknown): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
        return malformed('project count');
    return value;
}

function number(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function column(value: unknown): value is ProjectColumn {
    return (
        value === 'needs_you' ||
        value === 'running' ||
        value === 'done' ||
        value === 'failed'
    );
}

function textFields<T extends string>(
    value: Record<string, unknown>,
    names: T[]
): value is Record<string, unknown> & Record<T, string> {
    return names.every((name) => typeof value[name] === 'string');
}

function errorMessage(value: unknown, status: number): string {
    return isRecord(value) &&
        isRecord(value.error) &&
        typeof value.error.message === 'string'
        ? value.error.message
        : `Workbench cloud request failed (HTTP ${status})`;
}

function malformed(kind: string): never {
    throw new Error(`The Workbench cloud API returned malformed ${kind}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return RowReader.isRecord(value);
}
