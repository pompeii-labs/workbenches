import {
    CLOUD_REAUTHENTICATE_CLOSE,
    type CloudRuns,
    isCloudTerminal,
    type TrackedCloudSession,
} from '../cloud/index.js';
import type { CloudSessionStore } from '../database/cloud/sessions.js';
import {
    type CloudProject,
    type CloudProjectClient,
    type CloudProjectFrame,
    CloudProjectsUnsupportedError,
    type CloudProjectTask,
} from '../projects/index.js';
import type { ProjectStore } from '../projects/store.js';
import type {
    RegistryAccount,
    RegistryAccountStore,
} from '../registry/account-store.js';
import type { WorkbenchEvent } from '../runs/events.js';
import type {
    StudioEventsPage,
    StudioOutcomeFile,
    StudioRun,
    StudioTask,
} from './contracts.js';
import { isRecord } from './values.js';
import {
    applyEvent,
    type CloudProjectSummary,
    type CloudView,
    cloudProjectSummary,
    count,
    foldRun,
    frameTask,
    parseOutcomeFile,
    runFrom,
    sameProject,
    taskFrom,
    terminalEvent,
    trackedTaskFrom,
} from './views/cloud.js';

/** What the realtime cloud subscriptions report to the Studio server. */
export interface StudioCloudListener {
    frame(frame: CloudProjectFrame): void;
    runEvent(runId: string): void;
}

/**
 * The cloud side of Studio: the organization's project tasks and the latest
 * view of each tracked cloud run, kept current by realtime subscriptions
 * while a Studio client is connected.
 */
export class StudioCloudRuns {
    readonly #projectSummaries = new Map<string, CloudProject>();
    readonly #projectIds = new Map<string, number>();
    readonly #tasks = new Map<string, StudioTask>();
    readonly #fallbackViews = new Map<string, CloudView>();
    readonly #views = new Map<string, CloudView>();
    readonly #loads = new Map<string, Promise<CloudView>>();
    readonly #runSockets = new Map<string, WebSocket>();
    readonly #runSubscribing = new Set<string>();
    readonly #runReconnects = new Map<string, ReturnType<typeof setTimeout>>();
    readonly #runReconnectAttempts = new Map<string, number>();
    #load: Promise<void> | undefined;
    #loadedOrganization: string | undefined;
    #projectSocket: WebSocket | undefined;
    #projectReconnect: ReturnType<typeof setTimeout> | undefined;
    #projectReconnectAttempt = 0;
    #projectsUnsupported = false;
    #listener: StudioCloudListener | undefined;

    constructor(
        readonly runs: CloudRuns,
        private readonly accounts: Pick<RegistryAccountStore, 'current'>,
        private readonly client: Pick<CloudProjectClient, 'tasks' | 'subscribe'>,
        private readonly tracked: CloudSessionStore,
        private readonly projects: Pick<ProjectStore, 'load' | 'record'>
    ) {}

    login(): Promise<{ organization: string } | null> {
        return this.runs.login();
    }

    async tasks(project?: string): Promise<StudioTask[]> {
        await this.load();
        return [...this.#tasks.values()]
            .filter((task) => !project || sameProject(task.project, project))
            .toSorted((left, right) => right.updated_at.localeCompare(left.updated_at));
    }

    async project(name: string): Promise<CloudProjectSummary | null> {
        await this.load();
        const project = [...this.#projectSummaries.values()].find(
            (candidate) =>
                sameProject(candidate.name, name) || sameProject(candidate.slug, name)
        );
        const fallback = [...this.#fallbackViews.values()].filter((view) =>
            sameProject(view.task.project, name)
        );
        return cloudProjectSummary(project, fallback);
    }

    async task(id: string): Promise<{ task: StudioTask; runs: StudioRun[] }> {
        await this.load();
        const task = this.#tasks.get(id);
        if (!task) throw new Error('Studio task does not exist');
        const view = await this.view(task.latest_run_id);
        return { task, runs: [runFrom(view.run)] };
    }

    taskSummary(id: string): StudioTask | undefined {
        return this.#tasks.get(id);
    }

    projectRoutesUnsupported(): boolean {
        return this.#projectsUnsupported;
    }

    async run(id: string): Promise<StudioRun> {
        await this.load();
        return runFrom((await this.view(id)).run);
    }

    async events(id: string, after: number, limit: number): Promise<StudioEventsPage> {
        await this.load();
        const events = (await this.view(id)).events
            .filter((event) => event.sequence > after)
            .slice(0, limit);
        return { events, next: events.at(-1)?.sequence ?? after };
    }

    async outcomeFiles(id: string): Promise<StudioOutcomeFile[]> {
        await this.load();
        const value = await this.runs.outcomeFiles(id);
        if (!isRecord(value) || !Array.isArray(value.files))
            throw new Error('The Workbench cloud API returned malformed outcome files');
        return value.files.map((file) => parseOutcomeFile(file));
    }

    async outcomeFile(
        id: string,
        path: string
    ): Promise<{ bytes: Uint8Array; mediaType: string }> {
        await this.load();
        const response = await this.runs.outcomeFile(id, path);
        if (!response.ok)
            throw new Error(`Cloud outcome file failed (HTTP ${response.status})`);
        return {
            bytes: new Uint8Array(await response.arrayBuffer()),
            mediaType:
                response.headers.get('content-type') ?? 'application/octet-stream',
        };
    }

    /** Starts or keeps the realtime subscriptions, reporting to `listener`. */
    async start(listener: StudioCloudListener): Promise<void> {
        this.#listener = listener;
        await this.load();
        await this.subscribeProjects();
    }

    async openRun(id: string): Promise<boolean> {
        await this.load();
        if (!this.tracked.byRun(id)) return false;
        const view = await this.view(id);
        await this.subscribeRun(view);
        return true;
    }

    closeRun(id: string): void {
        const timer = this.#runReconnects.get(id);
        if (timer) clearTimeout(timer);
        this.#runReconnects.delete(id);
        this.#runReconnectAttempts.delete(id);
        this.#runSockets.get(id)?.close();
        this.#runSockets.delete(id);
    }

    stop(): void {
        this.#listener = undefined;
        if (this.#projectReconnect) clearTimeout(this.#projectReconnect);
        this.#projectReconnect = undefined;
        this.#projectReconnectAttempt = 0;
        this.#projectSocket?.close();
        this.#projectSocket = undefined;
        for (const timer of this.#runReconnects.values()) clearTimeout(timer);
        this.#runReconnects.clear();
        this.#runReconnectAttempts.clear();
        for (const socket of this.#runSockets.values()) socket.close();
        this.#runSockets.clear();
        this.#runSubscribing.clear();
    }

    async wake(runId: string): Promise<boolean> {
        if (!this.tracked.byRun(runId)) return false;
        await this.load(true);
        return this.tracked.byRun(runId) !== undefined;
    }

    private async load(force = false): Promise<void> {
        const account = await this.accounts.current();
        if (!account || new Date(account.expiresAt) <= new Date()) {
            this.clearProjects();
            return;
        }
        if (!force && this.#loadedOrganization === account.slug && !this.#load) return;
        if (this.#load) return this.#load;
        const loading = this.loadProjects(account).finally(() => {
            if (this.#load === loading) this.#load = undefined;
        });
        this.#load = loading;
        return loading;
    }

    private async loadProjects(account: RegistryAccount): Promise<void> {
        const listing = await this.projects.load();
        this.#projectsUnsupported = listing.unsupported;
        const records = listing.projects;
        let projects = listing.cloud ?? [];
        let pages: CloudProjectTask[][];
        try {
            pages = await Promise.all(
                projects.map((project) => this.client.tasks(account, project.slug))
            );
        } catch (error) {
            if (!(error instanceof CloudProjectsUnsupportedError)) throw error;
            this.#projectsUnsupported = true;
            projects = [];
            pages = [];
        }
        const ids = new Map(records.map((project) => [project.slug, project.id]));
        this.#projectIds.clear();
        for (const [slug, id] of ids) this.#projectIds.set(slug, id);
        this.#loadedOrganization = account.slug;
        this.#projectSummaries.clear();
        for (const project of projects)
            this.#projectSummaries.set(project.slug, project);
        const tasks = new Map<string, StudioTask>();
        for (const task of pages.flat()) {
            const mapped = taskFrom(task);
            tasks.set(mapped.id, mapped);
            this.trackTask(task);
        }
        const tracked = this.tracked
            .list()
            .filter(
                (session) =>
                    session.organization === account.slug &&
                    !tasks.has(session.sessionId)
            );
        const fallback = await Promise.all(
            tracked.map(async (session) => {
                const view = await this.ensure(session);
                view.task = trackedTaskFrom(session, view.run, view.events);
                tasks.set(view.task.id, view.task);
                return view;
            })
        );
        this.#fallbackViews.clear();
        for (const view of fallback) this.#fallbackViews.set(view.task.id, view);
        this.#tasks.clear();
        for (const [id, task] of tasks) this.#tasks.set(id, task);
    }

    private clearProjects(): void {
        this.#loadedOrganization = undefined;
        this.#projectsUnsupported = false;
        this.#projectSummaries.clear();
        this.#projectIds.clear();
        this.#tasks.clear();
        this.#fallbackViews.clear();
    }

    private async view(id: string): Promise<CloudView> {
        const existing = this.#views.get(id);
        if (existing) return existing;
        const tracked = this.tracked.byRun(id);
        if (!tracked) throw new Error('Tracked cloud run does not exist');
        return this.ensure(tracked);
    }

    private ensure(tracked: TrackedCloudSession): Promise<CloudView> {
        const existing = this.#views.get(tracked.latestRunId);
        if (existing) return Promise.resolve(existing);
        const loading = this.#loads.get(tracked.latestRunId);
        if (loading) return loading;
        const created = Promise.all([
            this.runs.run(tracked.latestRunId),
            this.allEvents(tracked.latestRunId),
        ])
            .then(([run, events]) => {
                foldRun(run, events);
                const task =
                    this.#tasks.get(tracked.sessionId) ??
                    trackedTaskFrom(tracked, run, events);
                const view = { tracked, run, events, task };
                this.#views.set(run.id, view);
                this.#loads.delete(run.id);
                return view;
            })
            .catch((error: unknown) => {
                this.#loads.delete(tracked.latestRunId);
                throw error;
            });
        this.#loads.set(tracked.latestRunId, created);
        return created;
    }

    private async allEvents(id: string): Promise<WorkbenchEvent[]> {
        const events: WorkbenchEvent[] = [];
        let after = 0;
        while (true) {
            const page = await this.runs.events(id, after, 500);
            events.push(...page.events);
            if (page.events.length < 500 || page.next === after) return events;
            after = page.next;
        }
    }

    private async subscribeProjects(): Promise<void> {
        if (!this.#listener || this.#projectsUnsupported || this.#projectSocket) return;
        const account = await this.accounts.current();
        if (!account) return;
        let socket: WebSocket | undefined;
        socket = this.client.subscribe(account, {
            frame: (frame) => {
                this.#projectReconnectAttempt = 0;
                if (frame.type === 'task') {
                    const task = taskFrom(frame.task);
                    this.#tasks.set(frame.task.id, task);
                    this.#fallbackViews.delete(frame.task.id);
                    const view = this.#views.get(frame.task.latest_run_id);
                    if (view) view.task = task;
                    this.trackTask(frame.task);
                } else {
                    this.#projectSummaries.set(frame.project.slug, frame.project);
                    if (this.#loadedOrganization) {
                        const mirrored = this.projects.record(
                            this.#loadedOrganization,
                            frame.project
                        );
                        this.#projectIds.set(frame.project.slug, mirrored.id);
                        for (const task of this.#tasks.values()) {
                            if (sameProject(task.project, frame.project.name)) {
                                const cloudTask = frameTask(task, frame.project.slug);
                                this.trackTask(cloudTask);
                            }
                        }
                    }
                }
                this.#listener?.frame(frame);
            },
            close: (code) => this.reconnectProjects(socket, code),
            error: () => this.reconnectProjects(socket),
        });
        if (this.#listener) this.#projectSocket = socket;
        else socket.close();
    }

    private reconnectProjects(socket?: WebSocket, code?: number): void {
        if (socket && this.#projectSocket !== socket) return;
        this.#projectSocket = undefined;
        if (!this.#listener || this.#projectReconnect) return;
        if (code === CLOUD_REAUTHENTICATE_CLOSE) {
            void this.subscribeProjects().catch(() => this.reconnectProjects());
            return;
        }
        const delay = Math.min(1_000 * 2 ** this.#projectReconnectAttempt, 30_000);
        this.#projectReconnectAttempt += 1;
        this.#projectReconnect = setTimeout(() => {
            this.#projectReconnect = undefined;
            if (!this.#listener) return;
            void this.subscribeProjects().catch(() => this.reconnectProjects());
        }, delay);
    }

    private async subscribeRun(view: CloudView): Promise<void> {
        if (
            !this.#listener ||
            isCloudTerminal(view.run.status) ||
            this.#runSockets.has(view.run.id) ||
            this.#runSubscribing.has(view.run.id)
        )
            return;
        this.#runSubscribing.add(view.run.id);
        let socket: WebSocket | undefined;
        try {
            socket = await this.runs.subscribe(
                view.run.id,
                view.events.at(-1)?.sequence ?? 0,
                {
                    event: (event) => {
                        this.#runReconnectAttempts.delete(view.run.id);
                        void this.receive(view, event).then(
                            () => terminalEvent(event) && socket?.close(),
                            () => terminalEvent(event) && socket?.close()
                        );
                    },
                    close: (code) => this.reconnectRun(view, socket, code),
                    error: () => this.reconnectRun(view, socket),
                }
            );
            if (this.#listener && !isCloudTerminal(view.run.status))
                this.#runSockets.set(view.run.id, socket);
            else socket.close();
        } finally {
            this.#runSubscribing.delete(view.run.id);
        }
    }

    private reconnectRun(view: CloudView, socket?: WebSocket, code?: number): void {
        if (socket && this.#runSockets.get(view.run.id) !== socket) return;
        this.#runSockets.delete(view.run.id);
        if (
            !this.#listener ||
            isCloudTerminal(view.run.status) ||
            this.#runReconnects.has(view.run.id)
        )
            return;
        if (code === CLOUD_REAUTHENTICATE_CLOSE) {
            void this.subscribeRun(view).catch(() => this.reconnectRun(view));
            return;
        }
        const attempt = this.#runReconnectAttempts.get(view.run.id) ?? 0;
        const delay = Math.min(1_000 * 2 ** attempt, 30_000);
        this.#runReconnectAttempts.set(view.run.id, attempt + 1);
        const timer = setTimeout(() => {
            this.#runReconnects.delete(view.run.id);
            if (!this.#listener || isCloudTerminal(view.run.status)) return;
            void this.subscribeRun(view).catch(() => this.reconnectRun(view));
        }, delay);
        this.#runReconnects.set(view.run.id, timer);
    }

    private async receive(view: CloudView, event: WorkbenchEvent): Promise<void> {
        if (event.sequence <= (view.events.at(-1)?.sequence ?? 0)) return;
        const previousStatus = view.run.status;
        view.events.push(event);
        applyEvent(view.run, view.events, event);
        if (event.type === 'usage.updated' && isRecord(event.data)) {
            const usage = view.run.usage ?? {
                input_tokens: 0,
                output_tokens: 0,
                cost_usd: null,
            };
            usage.input_tokens += count(event.data.input_tokens);
            usage.output_tokens += count(event.data.output_tokens);
            const cost = count(event.data.cost_usd);
            if (cost > 0) usage.cost_usd = (usage.cost_usd ?? 0) + cost;
            view.run.usage = usage;
        }
        if (this.#fallbackViews.has(view.tracked.sessionId)) {
            const enteredRunning =
                previousStatus !== 'running' &&
                view.run.status === 'running' &&
                view.run.started_at === null;
            if (enteredRunning || terminalEvent(event)) {
                try {
                    view.run = await this.runs.run(view.run.id);
                } catch {}
            }
            view.task = trackedTaskFrom(view.tracked, view.run, view.events);
            this.#tasks.set(view.task.id, view.task);
        }
        this.#listener?.runEvent(view.run.id);
    }

    private trackTask(task: CloudProjectTask): void {
        const projectId = this.#projectIds.get(task.project.slug);
        if (projectId === undefined || !this.#loadedOrganization) return;
        this.tracked.track({
            sessionId: task.id,
            latestRunId: task.latest_run_id,
            organization: this.#loadedOrganization,
            projectId,
            workbench: task.workbench.name,
            title: task.title,
            createdAt: task.created_at,
        });
    }
}
