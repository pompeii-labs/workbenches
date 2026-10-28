import { WorkerRunAdmission } from './admission.js';
import { WorkerAssignments } from './assignments.js';
import {
    WorkerChannel as Channel,
    type WorkerChannel,
    type WorkerSocketFactory,
    webSocketFactory,
} from './connection.js';
import type { WorkerRunHost } from './contracts.js';
import type {
    WorkerHome,
    WorkerRegistrationRecord,
    WorkerSettings,
    WorkerStopMode,
} from './home.js';
import { WorkerJanitor } from './janitor.js';
import { duration, excerpt, type WorkerLog } from './log.js';
import type { WorkerMachineProbe } from './machine.js';
import {
    parseServerMessage,
    type ServerMessage,
    WORKER_CLOSE_CODES,
    WORKER_PROTOCOL,
    type WorkerCommand,
    type WorkerMessage,
} from './protocol.js';
import type { WorkerSignIns } from './signin.js';
import { WorkerEventStream } from './stream.js';
import { WorkerRunTracker, type WorkerUploader } from './tracker.js';

export interface WorkerDaemonOptions {
    home: WorkerHome;
    registration: WorkerRegistrationRecord;
    /** What the worker offers: the runtimes this machine can run of those it may. */
    settings: WorkerSettings;
    host: WorkerRunHost;
    api: WorkerUploader & { readonly connectUrl: string };
    machine: Pick<WorkerMachineProbe, 'describe'>;
    log: WorkerLog;
    version: string;
    /** Removes old logs, workspaces, packages, and records on a schedule. */
    janitor?: Pick<WorkerJanitor, 'sweep'>;
    /** Why this machine cannot take repository runs, which it then refuses. */
    repositoryRefusal?: string;
    /** Runs members' runner sign-ins, reporting through `send`. Without it every sign-in fails. */
    signIns?: (
        send: (message: WorkerMessage) => boolean
    ) => Pick<
        WorkerSignIns,
        'start' | 'attach' | 'input' | 'resize' | 'secret' | 'cancel' | 'close'
    >;
    socket?: WorkerSocketFactory;
    tickMilliseconds?: number;
    /**
     * How long a stopping daemon with no active runs waits for the server to
     * acknowledge its last events before it exits anyway (default 5 seconds).
     */
    acknowledgeMilliseconds?: number;
    /** The delay before reconnect attempt `attempt`, starting at 0. */
    backoff?: (attempt: number) => number;
    now?: () => Date;
    pid?: number;
}

/**
 * The worker process: one outbound connection to workbenches.dev, runs
 * started as detached engine sessions, their events streamed with sequences,
 * and commands relayed into the session controls. Members' runner sign-ins
 * run on the server's request. Runs outlive the
 * connection and the process; on reconnect every event after the server's
 * stored sequence is sent again.
 */
export class WorkerDaemon {
    readonly #options: WorkerDaemonOptions;
    readonly #assignments: WorkerAssignments;
    readonly #tracker: WorkerRunTracker;
    readonly #now: () => Date;
    readonly #socket: WorkerSocketFactory;
    readonly #startedAt: Date;
    readonly #stream: WorkerEventStream;
    readonly #admission: WorkerRunAdmission;
    readonly #signIns:
        | Pick<
              WorkerSignIns,
              'start' | 'attach' | 'input' | 'resize' | 'secret' | 'cancel' | 'close'
          >
        | undefined;
    #channel: WorkerChannel | undefined;
    #welcomed = false;
    #stopping: WorkerStopMode | null = null;
    #exit: { code: number; reason?: string } | undefined;
    #pumping = false;
    #dirty = true;
    #onlineSince: Date | undefined;
    #offlineSince: Date | undefined;
    #connectedBefore = false;
    /** When a stopping daemon first had no active runs, to bound its wait for acknowledgements. */
    #idleSince: number | undefined;
    /** When the janitor last swept, in milliseconds. */
    #swept: number | undefined;
    /** Sleeps that end on any wake, and sleeps that end only when the daemon exits. */
    readonly #wakeable = new Set<() => void>();
    readonly #sleepers = new Set<() => void>();

    constructor(options: WorkerDaemonOptions) {
        this.#options = options;
        this.#now = options.now ?? (() => new Date());
        this.#socket = options.socket ?? webSocketFactory;
        this.#startedAt = this.#now();
        this.#assignments = new WorkerAssignments(options.home);
        this.#stream = new WorkerEventStream(
            this.#assignments,
            options.host,
            (message) => this.#send(message)
        );
        this.#tracker = new WorkerRunTracker(
            this.#assignments,
            options.host,
            options.api,
            options.log,
            this.#now
        );
        this.#admission = new WorkerRunAdmission({
            assignments: this.#assignments,
            host: options.host,
            home: options.home,
            settings: options.settings,
            log: options.log,
            now: this.#now,
            send: (message) => this.#send(message),
            stopping: () => this.#stopping !== null,
            ...(options.repositoryRefusal
                ? { repositoryRefusal: options.repositoryRefusal }
                : {}),
            changed: () => {
                this.#dirty = true;
                this.#wake();
            },
        });
        this.#signIns = options.signIns?.((message) => this.#send(message));
    }

    /** Runs until stopped or the server ends the worker. Resolves the process exit code. */
    async run(): Promise<number> {
        await this.#assignments.load();
        await this.#options.home.clearStopRequest();
        // What a run that ended while the daemon was down still holds is released now.
        await this.#options.host
            .recover(this.#assignments.active())
            .catch((error: unknown) => {
                this.#options.log.write(
                    `cleanup after restart failed: ${excerpt(error instanceof Error ? error.message : String(error), 80)}`
                );
            });
        const ticker = this.#tick();
        let attempt = 0;
        while (!this.#exit) {
            let channel: WorkerChannel;
            try {
                channel = await Channel.open(
                    this.#socket,
                    this.#options.api.connectUrl,
                    this.#options.registration.key
                );
            } catch (error) {
                // Say why once per outage, not on every retry.
                if (attempt === 0) {
                    this.#options.log.write(
                        `cannot reach ${this.#options.api.connectUrl}: ${error instanceof Error ? error.message : String(error)}`
                    );
                }
                await this.#sleep(this.#backoff(attempt++));
                continue;
            }
            const close = await this.#serve(channel);
            if (this.#welcomed) attempt = 0;
            this.#disconnected();
            if (this.#exit) break;
            const stop = closeReason(close.code);
            if (stop) {
                this.#options.log.write(stop);
                this.#exit = { code: 0, reason: stop };
                break;
            }
            await this.#sleep(this.#backoff(attempt++));
        }
        await ticker;
        this.#signIns?.close();
        await this.#writeState();
        await this.#options.log.flush();
        return this.#exit.code;
    }

    /** Asks the daemon to stop: after its runs finish, or now after cancelling them. */
    stop(mode: WorkerStopMode): void {
        if (this.#stopping === 'now') return;
        this.#stopping = mode;
        this.#dirty = true;
        this.#wake();
    }

    /** Ends the process now, for a service manager signal. Runs continue as detached sessions. */
    terminate(): void {
        this.#exit ??= { code: 0 };
        this.#channel?.close(1000, 'worker stopped');
        this.#wake();
    }

    async #serve(channel: WorkerChannel): Promise<{ code: number; reason: string }> {
        this.#channel = channel;
        this.#welcomed = false;
        channel.onMessage((text) => {
            void this.#receive(text).catch((error: unknown) => {
                this.#options.log.write(
                    `ignored a server message: ${excerpt(error instanceof Error ? error.message : String(error), 80)}`
                );
            });
        });
        const machine = await this.#options.machine.describe();
        channel.send({
            type: 'hello',
            protocol: WORKER_PROTOCOL,
            wb_version: this.#options.version,
            machine,
            runtimes: this.#options.settings.runtimes,
            slots: this.#options.settings.slots,
            runs: this.#stream.cursors(),
        });
        return channel.closed;
    }

    async #receive(text: string): Promise<void> {
        const message = parseServerMessage(text);
        if (!message) return;
        await this.#handle(message);
    }

    async #handle(message: ServerMessage): Promise<void> {
        if (message.type === 'welcome') return this.#welcome(message.stored);
        if (message.type === 'stored') {
            this.#stream.stored(message.run_id, message.sequence);
            return;
        }
        if (message.type === 'run.start') return this.#admission.start(message);
        if (message.type === 'connect.start') return this.#signIns?.start(message);
        if (message.type === 'connect.attach')
            return this.#signIns?.attach(message.connect_id, message);
        if (message.type === 'connect.input')
            return this.#signIns?.input(message.connect_id, message.data);
        if (message.type === 'connect.resize')
            return this.#signIns?.resize(message.connect_id, message);
        if (message.type === 'connect.secret')
            return this.#signIns?.secret(message.connect_id, message.text);
        if (message.type === 'connect.cancel')
            return this.#signIns?.cancel(message.connect_id);
        return this.#command(message);
    }

    async #welcome(stored: Array<{ run_id: string; sequence: number }>): Promise<void> {
        const resent = this.#stream.welcome(stored);
        this.#welcomed = true;
        const now = this.#now();
        if (this.#connectedBefore && this.#offlineSince) {
            this.#options.log.write(
                `reconnected after ${duration(now.getTime() - this.#offlineSince.getTime())} offline, ${resent} ${resent === 1 ? 'event' : 'events'} resent`
            );
        } else {
            const machine = await this.#options.machine.describe();
            const slots = this.#options.settings.slots;
            this.#options.log.write(
                [
                    'online',
                    `${slots} ${slots === 1 ? 'slot' : 'slots'}`,
                    ...(machine.docker ? [`docker ${machine.docker.version}`] : []),
                    `runtimes ${this.#options.settings.runtimes.join(',')}`,
                ].join(', ')
            );
        }
        this.#connectedBefore = true;
        this.#onlineSince = now;
        this.#offlineSince = undefined;
        this.#dirty = true;
        this.#wake();
    }

    async #command(command: WorkerCommand): Promise<void> {
        const assignment = this.#assignments.get(command.run_id);
        const done = (status: 'delivered' | 'rejected', reason?: string) =>
            this.#send({
                type: 'command.done',
                command_id: command.command_id,
                status,
                ...(reason ? { reason } : {}),
            });
        if (!assignment?.session_id) {
            done('rejected', 'This worker has no session for the run');
            return;
        }
        const start = this.#assignments.start(command.run_id);
        try {
            await this.#options.host.command(assignment.session_id, command, {
                run: {
                    run_id: assignment.run_id,
                    runtime: assignment.runtime,
                    member_id: assignment.member_id,
                    runner: assignment.runner,
                    connection: assignment.connection,
                },
                ...(start ? { start } : {}),
            });
            // A finished session continued with send is followed again.
            if (command.kind !== 'cancel') this.#tracker.wake(assignment.run_id);
            done('delivered');
        } catch (error) {
            done(
                'rejected',
                error instanceof Error ? error.message : 'The command was not delivered'
            );
        }
        this.#wake();
    }

    /** The periodic work: stop requests, run tracking, event streaming, logs, and state. */
    async #tick(): Promise<void> {
        while (!this.#exit) {
            await this.#pump().catch(() => {});
            await this.#sleep(this.#options.tickMilliseconds ?? 500, true);
        }
    }

    async #pump(): Promise<void> {
        if (this.#pumping) return;
        this.#pumping = true;
        try {
            const requested = await this.#options.home.readStopRequest();
            if (requested) {
                await this.#options.home.clearStopRequest();
                this.stop(requested);
            }
            if (this.#stopping === 'now' && this.#assignments.active().length) {
                await this.#tracker.cancelAll();
            }
            if (await this.#tracker.observe()) {
                this.#dirty = true;
                await this.#assignments.save();
            }
            await this.#sweep();
            if (this.#channel?.open && this.#welcomed) await this.#stream.flush();
            this.#flushLog();
            if (this.#dirty) {
                this.#dirty = false;
                await this.#writeState();
            }
            if (this.#stopping && this.#drained()) {
                const mode = this.#stopping;
                this.#options.log.write(
                    mode === 'now' ? 'stopped' : 'stopped after its runs finished'
                );
                this.#flushLog();
                this.#exit = { code: 0 };
                this.#channel?.close(1000, 'worker stopped');
                this.#wake();
            }
        } finally {
            this.#pumping = false;
        }
    }

    /** At start and then hourly, removes what finished runs left past the retention. */
    async #sweep(): Promise<void> {
        const janitor = this.#options.janitor;
        const now = this.#now();
        if (!janitor || (this.#swept && now.getTime() - this.#swept < 60 * 60 * 1000))
            return;
        this.#swept = now.getTime();
        const expired = this.#assignments.expire(WorkerJanitor.horizon(now));
        if (expired.length) await this.#assignments.save();
        await janitor.sweep(expired, now).catch((error: unknown) => {
            this.#options.log.write(
                `cleanup failed: ${excerpt(error instanceof Error ? error.message : String(error), 80)}`
            );
        });
    }

    #drained(): boolean {
        if (this.#assignments.active().length || this.#admission.pending) {
            this.#idleSince = undefined;
            return false;
        }
        // Offline, events stay on disk and are sent after the next start.
        if (!this.#channel?.open || !this.#welcomed) return true;
        if (this.#stream.acknowledged()) return true;
        // The server may never acknowledge a run it already finished, so the
        // wait is bounded; what it did not store is sent again after the next start.
        const now = this.#now().getTime();
        this.#idleSince ??= now;
        return now - this.#idleSince >= (this.#options.acknowledgeMilliseconds ?? 5000);
    }

    #flushLog(): void {
        if (!this.#channel?.open || !this.#welcomed) return;
        const lines = this.#options.log.take();
        if (lines.length && !this.#send({ type: 'log', lines })) {
            this.#options.log.restore(lines);
        }
    }

    #send(message: WorkerMessage): boolean {
        return this.#channel?.send(message) ?? false;
    }

    #disconnected(): void {
        this.#channel = undefined;
        this.#welcomed = false;
        this.#onlineSince = undefined;
        this.#offlineSince ??= this.#now();
        this.#dirty = true;
    }

    async #writeState(): Promise<void> {
        const registration = this.#options.registration;
        await this.#options.home
            .writeState({
                pid: this.#options.pid ?? process.pid,
                name: registration.name,
                started_at: this.#startedAt.toISOString(),
                online: Boolean(this.#onlineSince) && !this.#exit,
                changed_at: (
                    this.#onlineSince ??
                    this.#offlineSince ??
                    this.#startedAt
                ).toISOString(),
                slots: this.#options.settings.slots,
                runtimes: this.#options.settings.runtimes,
                runs: this.#assignments.active().map((run) => ({
                    run_id: run.run_id,
                    session_id: run.session_id ?? '',
                    workbench: run.workbench,
                    runtime: run.runtime,
                    state: run.state,
                    started_at: run.accepted_at,
                })),
                stopping: this.#exit ? null : this.#stopping,
                ...(this.#exit?.reason ? { stopped: this.#exit.reason } : {}),
            })
            .catch(() => {});
    }

    #backoff(attempt: number): number {
        if (this.#options.backoff) return this.#options.backoff(attempt);
        const base = Math.min(60_000, 1000 * 2 ** Math.min(attempt, 6));
        return base / 2 + Math.random() * (base / 2);
    }

    #wake(): void {
        for (const wake of this.#wakeable) wake();
        if (this.#exit) for (const wake of this.#sleepers) wake();
    }

    /** Sleeps, ending early on a wake when `wakeable`, and always when the daemon exits. */
    #sleep(milliseconds: number, wakeable = false): Promise<void> {
        return new Promise((resolve) => {
            const waiters = wakeable ? this.#wakeable : this.#sleepers;
            const done = () => {
                clearTimeout(timer);
                waiters.delete(done);
                resolve();
            };
            const timer = setTimeout(done, milliseconds);
            waiters.add(done);
        });
    }
}

/** The log line for a close code that ends the worker, or undefined to reconnect. */
function closeReason(code: number): string | undefined {
    if (code === WORKER_CLOSE_CODES.revoked)
        return 'stopped: the worker key was revoked. Run wb worker remove, then wb worker start --name <name> to register this machine again';
    if (code === WORKER_CLOSE_CODES.replaced)
        return 'stopped: a newer connection for this worker took over';
    if (code === WORKER_CLOSE_CODES.unsupported)
        return 'stopped: workbenches.dev does not support this version of wb. Run wb update';
    return undefined;
}
