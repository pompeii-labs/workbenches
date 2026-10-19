import type {
    CloudSessionStore,
    TrackedCloudSession,
} from '../database/cloud/sessions.js';
import type { ProjectStore } from '../projects/store.js';
import type {
    RegistryAccount,
    RegistryAccountStore,
} from '../registry/account-store.js';
import type { RegistryClient } from '../registry/client.js';
import type { WorkbenchEvent } from '../runs/events.js';
import type { RunChangeListener } from '../runs/store.js';
import {
    type CloudCommandReceipt,
    type CloudRun,
    parseCloudCommand,
    parseCloudEvent,
    parseCloudRun,
} from './contracts.js';

export interface CloudRunRequest {
    workbench: string | { version_id: string };
    task: string;
    project: string;
    org?: string;
    session_id?: string;
    repository?: string;
    ref?: string;
    idempotency_key?: string;
}

export interface CloudEventsPage {
    events: WorkbenchEvent[];
    next: number;
}

/** Cloud runs started or seen from this machine, through the held organization key. */
export class CloudRuns {
    constructor(
        private readonly accounts: Pick<RegistryAccountStore, 'current' | 'require'>,
        private readonly client: Pick<RegistryClient, 'apiUrl'>,
        private readonly sessions: CloudSessionStore,
        private readonly projects: Pick<ProjectStore, 'resolve'>,
        private readonly changes: RunChangeListener
    ) {}

    async login(): Promise<{ organization: string } | null> {
        const account = await this.accounts.current();
        return account && new Date(account.expiresAt) > new Date()
            ? { organization: account.slug }
            : null;
    }

    async available(organization: string): Promise<boolean> {
        const account = await this.accounts.current(organization);
        return Boolean(account && new Date(account.expiresAt) > new Date());
    }

    async start(request: CloudRunRequest): Promise<{
        session_id: string;
        run_id: string;
    }> {
        const project = await this.projects.resolve(request.project);
        if (!request.task.trim()) throw new Error('Run task cannot be empty');
        if ((request.repository === undefined) !== (request.ref === undefined))
            throw new Error('repository and ref must be given together');
        const account = await this.requireAccount(request.org);
        const run = await this.requestRun(account, 'POST', '/v1/runs', {
            workbench: request.workbench,
            task: request.task,
            project: project.slug,
            idempotency_key: request.idempotency_key ?? crypto.randomUUID(),
            ...(request.session_id !== undefined
                ? { session_id: request.session_id }
                : {}),
            ...(request.repository !== undefined && request.ref !== undefined
                ? { workspace: { repository: request.repository, ref: request.ref } }
                : {}),
        });
        this.sessions.track({
            sessionId: run.session_id,
            latestRunId: run.id,
            organization: account.slug,
            projectId: project.id,
            workbench: `${run.workbench.organization_slug}/${run.workbench.slug}`,
            title: titleFrom(run.task),
            createdAt: run.created_at,
        });
        this.changes.notify(run.id);
        return { session_id: run.session_id, run_id: run.id };
    }

    trackedSession(id: string): TrackedCloudSession | undefined {
        return this.sessions.bySession(id);
    }

    trackedRun(id: string): TrackedCloudSession | undefined {
        return this.sessions.byRun(id);
    }

    tracked(): TrackedCloudSession[] {
        return this.sessions.list();
    }

    async run(id: string): Promise<CloudRun> {
        const tracked = this.sessions.byRun(id);
        if (!tracked) throw new Error('Tracked cloud run does not exist');
        return this.requestRun(
            await this.requireAccount(tracked.organization),
            'GET',
            `/v1/runs/${encodeURIComponent(id)}`
        );
    }

    async runs(session: TrackedCloudSession): Promise<CloudRun[]> {
        const value = await this.request(
            await this.requireAccount(session.organization),
            'GET',
            '/v1/runs',
            undefined,
            { session: session.sessionId, limit: 100 }
        );
        if (!isRecord(value) || !Array.isArray(value.runs))
            throw new Error('The Workbench cloud API returned malformed runs');
        return value.runs.map(parseCloudRun);
    }

    async events(id: string, after: number, limit = 500): Promise<CloudEventsPage> {
        const tracked = this.sessions.byRun(id);
        if (!tracked) throw new Error('Tracked cloud run does not exist');
        const value = await this.request(
            await this.requireAccount(tracked.organization),
            'GET',
            `/v1/runs/${encodeURIComponent(id)}/events`,
            undefined,
            { after, limit }
        );
        if (
            !isRecord(value) ||
            !Array.isArray(value.events) ||
            typeof value.next !== 'number' ||
            !Number.isSafeInteger(value.next)
        )
            throw new Error('The Workbench cloud API returned malformed events');
        return { events: value.events.map(parseCloudEvent), next: value.next };
    }

    async command(
        sessionId: string,
        kind: 'send' | 'steer' | 'queue' | 'answer' | 'cancel',
        payload: Record<string, unknown>,
        idempotencyKey: string = crypto.randomUUID()
    ): Promise<CloudCommandReceipt> {
        const tracked = this.sessions.bySession(sessionId);
        if (!tracked) throw new Error('Tracked cloud session does not exist');
        const value = await this.request(
            await this.requireAccount(tracked.organization),
            'POST',
            `/v1/runs/${encodeURIComponent(tracked.latestRunId)}/commands`,
            { kind, payload, idempotency_key: idempotencyKey }
        );
        return parseCloudCommand(value);
    }

    async outcomeFiles(id: string): Promise<unknown> {
        const tracked = this.sessions.byRun(id);
        if (!tracked) throw new Error('Tracked cloud run does not exist');
        return this.request(
            await this.requireAccount(tracked.organization),
            'GET',
            `/v1/runs/${encodeURIComponent(id)}/outcome/files`
        );
    }

    async outcomeFile(id: string, path: string): Promise<Response> {
        const tracked = this.sessions.byRun(id);
        if (!tracked) throw new Error('Tracked cloud run does not exist');
        const account = await this.requireAccount(tracked.organization);
        return this.fetch(
            account,
            `/v1/runs/${encodeURIComponent(id)}/outcome/files/${path
                .split('/')
                .map(encodeURIComponent)
                .join('/')}`
        );
    }

    async subscribe(
        id: string,
        after: number,
        handlers: {
            event: (event: WorkbenchEvent) => void;
            close: (code: number) => void;
            error: () => void;
        }
    ): Promise<WebSocket> {
        const tracked = this.sessions.byRun(id);
        if (!tracked) throw new Error('Tracked cloud run does not exist');
        const account = await this.requireAccount(tracked.organization);
        const url = new URL(
            `/v1/runs/${encodeURIComponent(id)}/events`,
            this.client.apiUrl
        );
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
        url.searchParams.set('after', String(after));
        const socket = new WebSocket(url, {
            headers: { Authorization: `Bearer ${account.token}` },
        });
        socket.addEventListener('message', (message) => {
            try {
                handlers.event(parseCloudEvent(JSON.parse(String(message.data))));
            } catch {
                handlers.error();
                socket.close();
            }
        });
        socket.addEventListener('close', (close) => handlers.close(close.code));
        socket.addEventListener('error', handlers.error);
        return socket;
    }

    private async requireAccount(org?: string): Promise<RegistryAccount> {
        return this.accounts.require(org);
    }

    private async requestRun(
        account: RegistryAccount,
        method: 'GET' | 'POST',
        path: string,
        body?: unknown
    ): Promise<CloudRun> {
        return parseCloudRun(await this.request(account, method, path, body));
    }

    private async request(
        account: RegistryAccount,
        method: 'GET' | 'POST',
        path: string,
        body?: unknown,
        query: Record<string, string | number> = {}
    ): Promise<unknown> {
        const url = new URL(path, this.client.apiUrl);
        for (const [name, value] of Object.entries(query))
            url.searchParams.set(name, String(value));
        const response = await this.fetch(account, `${url.pathname}${url.search}`, {
            method,
            ...(body === undefined
                ? {}
                : {
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify(body),
                  }),
        });
        const value: unknown = await response.json().catch(() => null);
        if (!response.ok) {
            const message =
                isRecord(value) &&
                isRecord(value.error) &&
                typeof value.error.message === 'string'
                    ? value.error.message
                    : `Workbench cloud request failed (HTTP ${response.status})`;
            throw new Error(message);
        }
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

function titleFrom(task: string): string {
    const line = task.split('\n').find((candidate) => candidate.trim());
    return line?.trim().replace(/^#\s*/, '') || 'Untitled task';
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
