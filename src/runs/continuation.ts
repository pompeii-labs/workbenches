import { SessionStore, type StoredSession } from '../sessions/index.js';
import type { WorkbenchWorkspaceBinding } from '../types.js';
import type { ResolvedWorkbenchReference } from '../workbench/index.js';
import type { RunControlReceipt } from './control.js';
import { RunDispatcher } from './dispatcher.js';
import type { RunHandle } from './handle.js';
import { RunStore, type StoredRun } from './store.js';

export interface ContinueRunOptions {
    resolved: ResolvedWorkbenchReference;
    session: StoredSession;
    task: string;
    mode: 'foreground' | 'detached';
    environment: Record<string, string | undefined>;
    environmentOverrides?: boolean;
    workspaces?: WorkbenchWorkspaceBinding[];
    allowHostDocker?: boolean;
}

export interface ContinuedRun {
    sessionId: string;
    run: StoredRun;
    handle: RunHandle;
    inputId: string;
    afterSequence: number;
    receipt?: RunControlReceipt;
}

export interface OpenInteractiveRunOptions {
    resolved: ResolvedWorkbenchReference;
    reference: string;
    environment: Record<string, string | undefined>;
    workspaces?: WorkbenchWorkspaceBinding[];
    allowHostDocker?: boolean;
    session?: StoredSession;
}

interface RunContinuationDependencies {
    dispatcher?: Pick<RunDispatcher, 'prepare' | 'dispatch' | 'handle'>;
    runs?: Pick<RunStore, 'read' | 'readEvents' | 'reconcile'>;
    sessions?: {
        read(id: string): Promise<StoredSession>;
        exclusive<T>(id: string, operation: () => Promise<T>): Promise<T>;
    };
}

export class RunContinuation {
    readonly #dispatcher: Pick<RunDispatcher, 'prepare' | 'dispatch' | 'handle'>;
    readonly #runs: Pick<RunStore, 'read' | 'readEvents' | 'reconcile'>;
    readonly #sessions: NonNullable<RunContinuationDependencies['sessions']>;

    constructor(home: string, dependencies: RunContinuationDependencies = {}) {
        this.#dispatcher = dependencies.dispatcher ?? new RunDispatcher(home);
        this.#runs = dependencies.runs ?? new RunStore(home);
        this.#sessions = dependencies.sessions ?? new SessionStore(home);
    }

    async submit(options: ContinueRunOptions): Promise<ContinuedRun> {
        return this.#sessions.exclusive(options.session.id, async () => {
            const session = await this.#sessions.read(options.session.id);
            const current = await this.latestRun(session);
            if (!RunStore.isTerminal(current.status)) {
                return this.submitToActive(options, session, current);
            }
            return this.startTask(options, session);
        });
    }

    async open(options: OpenInteractiveRunOptions): Promise<RunHandle> {
        if (!options.session) return this.startInteractive(options);
        const sessionId = options.session.id;
        return this.#sessions.exclusive(sessionId, async () => {
            const session = await this.#sessions.read(sessionId);
            const current = await this.latestRun(session);
            if (!RunStore.isTerminal(current.status)) {
                const handle = this.#dispatcher.handle(current.id);
                try {
                    await handle.attach();
                    return handle;
                } catch (error) {
                    const refreshed = await this.latestRun(session);
                    if (!RunStore.isTerminal(refreshed.status)) throw error;
                }
            }
            return this.startInteractive({ ...options, session });
        });
    }

    private async submitToActive(
        options: ContinueRunOptions,
        session: StoredSession,
        run: StoredRun
    ): Promise<ContinuedRun> {
        if (options.environmentOverrides) {
            throw new Error(
                'Environment overrides cannot change an active Workbench execution'
            );
        }
        const events = await this.#runs.readEvents(run.id);
        const afterSequence = events.at(-1)?.sequence ?? 0;
        const handle = this.#dispatcher.handle(run.id);
        try {
            const receipt = await handle.followUp(options.task);
            return {
                sessionId: session.id,
                run,
                handle,
                inputId: receipt.id,
                afterSequence,
                receipt,
            };
        } catch (error) {
            const refreshed = await this.latestRun(session);
            if (!RunStore.isTerminal(refreshed.status)) throw error;
            return this.startTask(options, await this.#sessions.read(session.id));
        }
    }

    private async startTask(
        options: ContinueRunOptions,
        session: StoredSession
    ): Promise<ContinuedRun> {
        const stored = await this.#dispatcher.prepare({
            resolved: options.resolved,
            task: options.task,
            mode: options.mode,
            reference: session.reference,
            workspaces: options.workspaces ?? session.workspaces,
            ...(options.allowHostDocker !== undefined
                ? { allowHostDocker: options.allowHostDocker }
                : {}),
            session,
        });
        await this.#dispatcher.dispatch({
            id: stored.id,
            cwd: options.resolved.workspaceDirectory,
            environment: options.environment,
            waitForInitialTurn: true,
        });
        return {
            sessionId: session.id,
            run: stored,
            handle: this.#dispatcher.handle(stored.id),
            inputId: `input_${stored.id}`,
            afterSequence: 0,
        };
    }

    private async startInteractive(
        options: OpenInteractiveRunOptions
    ): Promise<RunHandle> {
        const stored = await this.#dispatcher.prepare({
            resolved: options.resolved,
            reference: options.reference,
            mode: 'interactive',
            workspaces: options.workspaces ?? options.session?.workspaces ?? [],
            ...(options.allowHostDocker !== undefined
                ? { allowHostDocker: options.allowHostDocker }
                : {}),
            ...(options.session ? { session: options.session } : {}),
        });
        await this.#dispatcher.dispatch({
            id: stored.id,
            cwd: options.resolved.workspaceDirectory,
            environment: options.environment,
        });
        const handle = this.#dispatcher.handle(stored.id);
        await handle.attach();
        return handle;
    }

    private async latestRun(session: StoredSession): Promise<StoredRun> {
        return this.#runs.reconcile(await this.#runs.read(session.latest_run_id));
    }
}
