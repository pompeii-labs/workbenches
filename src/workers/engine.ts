import type { SavedWorkbenchCatalog } from '../catalog/saved.js';
import type { CatalogWriter } from '../catalog/writer.js';
import { AuthenticationRequiredError } from '../connections/error.js';
import type { RunnerRegistry } from '../runners/registry.js';
import type { DetachedRunLauncher } from '../runs/detached.js';
import type { WorkbenchEvent } from '../runs/events.js';
import { RunStore } from '../runs/store.js';
import { RuntimeRegistry } from '../runtimes/registry.js';
import type { SessionControl } from '../sessions/control.js';
import type { SessionStore } from '../sessions/store.js';
import type { RemoteWorkbenchPackage } from '../sources/index.js';
import type { WorkbenchManifest } from '../types.js';
import { type HostDescriber, NodeHost } from '../workbench/host.js';
import {
    WorkbenchEnvironment,
    WorkbenchResolver,
    withRuntime,
} from '../workbench/index.js';
import { ReservedEnvironment } from '../workbench/reserved.js';
import { requirementsOf } from '../workbench/runtimes.js';
import { WorkerCheckout } from './checkout.js';
import {
    type WorkerAdmission,
    type WorkerOutcome,
    WorkerRejection,
    type WorkerRunContext,
    type WorkerRunHost,
} from './contracts.js';
import { runSpec, type WorkerRunEnvironment } from './environment.js';
import type { WorkerHome } from './home.js';
import { WorkerOutcomeArchive } from './outcome.js';
import type { RunStart, WorkerCommand } from './protocol.js';
import { WorkerSessionRuns } from './runs.js';
import { WorkerRunnerVersions } from './versions.js';

export interface WorkerEngineOptions {
    home: WorkerHome;
    services: {
        runs: Pick<RunStore, 'read' | 'readEventsAfter' | 'lastEvent' | 'reconcile'>;
        sessions: Pick<SessionStore, 'read'>;
        catalog: Pick<SavedWorkbenchCatalog, 'find'>;
        writer: Pick<CatalogWriter, 'addRemote' | 'remove'>;
        launcher: Pick<DetachedRunLauncher, 'start'>;
        control: Pick<SessionControl, 'send' | 'answer' | 'cancel'>;
    };
    runners: Pick<RunnerRegistry, 'find'>;
    environment: WorkerRunEnvironment;
    /** The worker's slug, which names it in `wb connect --worker`. */
    worker: string;
    /** The URL of the API the worker belongs to, the one place besides GitHub a repository is fetched from. */
    api: string;
    /** The machine the worker runs on. Defaults to this one. */
    host?: HostDescriber;
    /** Downloads the package archive behind a run's signed URL. */
    download: (url: string, versionId: string) => Promise<RemoteWorkbenchPackage>;
    /** Checks a local run's runner CLI is new enough. Defaults to asking this machine's. */
    versions?: Pick<WorkerRunnerVersions, 'check'>;
}

/**
 * Runs worker assignments as ordinary detached sessions in the worker's own
 * engine home. A session's runs are read as one stream, numbered
 * consecutively, so a continuation after `send` extends the run's sequence.
 */
export class WorkerEngine implements WorkerRunHost {
    readonly #options: WorkerEngineOptions;
    readonly #outcomes: WorkerOutcomeArchive;
    readonly #sessions: WorkerSessionRuns;
    readonly #versions: Pick<WorkerRunnerVersions, 'check'>;

    constructor(options: WorkerEngineOptions) {
        this.#options = options;
        this.#outcomes = new WorkerOutcomeArchive(options.home.root);
        this.#sessions = new WorkerSessionRuns(options.services);
        this.#versions = options.versions ?? new WorkerRunnerVersions();
    }

    async admit(start: RunStart): Promise<WorkerAdmission> {
        const alias = packageAlias(start.session_id);
        const existed = Boolean(await this.#options.services.catalog.find(alias));
        try {
            const workbench = await this.#options.download(
                start.workbench.download_url,
                start.workbench.version_id
            );
            await this.#options.services.writer.addRemote({ alias, workbench });
        } catch (error) {
            throw new WorkerRejection(
                `The Workbench package could not be prepared: ${message(error)}`
            );
        }
        const resolved = await new WorkbenchResolver().resolve(alias, {
            home: this.#options.home.root,
            savedOnly: true,
        });
        try {
            const workbench = withRuntime(resolved.workbench, start.runtime);
            // A GPU requirement passes on this machine's own GPU discovery,
            // never on an acknowledgement.
            await RuntimeRegistry.standard(
                this.#options.host ? { host: this.#options.host } : {}
            ).requirements.verify(workbench);
            // A declared name pulls its value from the run's environment, so
            // a package must not reach the worker's own settings through one.
            ReservedEnvironment.check(workbench);
            this.#checkCapacity(workbench.manifest);
            // A local run uses this machine's own CLI; a container brings its own.
            const runner = this.#options.runners.find(workbench.manifest.runner);
            if (runner && start.runtime === 'local') await this.#versions.check(runner);
            return {
                workbench: workbench.manifest.name,
                runner: workbench.manifest.runner,
                package: alias,
            };
        } catch (error) {
            // A package saved only for a run that is refused is not kept.
            if (!existed)
                await this.#options.services.writer.remove(alias).catch(() => {});
            throw new WorkerRejection(message(error));
        } finally {
            await resolved.cleanup();
        }
    }

    async launch(start: RunStart): Promise<string> {
        const directory = await this.#options.home.ensure(
            this.#options.home.workspaceDirectory(start.run_id)
        );
        const runner = await this.#runner(start);
        const environment = await this.#options.environment.build(
            runSpec(start),
            runner
        );
        // A repository run is a plain directory run on its own checkout,
        // fetched through the run's credential. The engine's own repository
        // mode, which uses a GitHub token, is never used by a worker.
        if (start.workspace)
            await new WorkerCheckout(this.#options.api).clone(
                start.workspace,
                directory,
                environment
            );
        const keys = { ...start.env };
        const connection = await this.#connection(
            {
                connection: start.connection,
                member_id: start.started_by.member_id,
                runner,
                runtime: start.runtime,
            },
            environment,
            keys
        );
        const run = await this.#start(
            start,
            directory,
            environment,
            keys,
            connection
        ).catch((error: unknown) => {
            // A run uses only its member's sign-ins or the keys it was sent.
            // The engine's own advice names this worker's private package
            // alias, so only its reason is kept.
            if (error instanceof AuthenticationRequiredError)
                throw new AuthenticationRequiredError(
                    `${error.message.split('. ')[0]?.replace(/\.$/, '')}. Run wb connect --worker ${this.#options.worker} ${runner}.`
                );
            throw error;
        });
        return run.session_id ?? run.id;
    }

    events(session: string, after: number): Promise<WorkbenchEvent[]> {
        return this.#sessions.events(session, after);
    }

    async active(session: string): Promise<boolean> {
        const latest = await this.#sessions.latest(session);
        if (!latest) return false;
        const run = await this.#options.services.runs.reconcile(latest);
        return !RunStore.isTerminal(run.status);
    }

    async command(
        session: string,
        command: WorkerCommand,
        context: WorkerRunContext
    ): Promise<void> {
        const control = this.#options.services.control;
        if (command.kind === 'cancel') {
            await control.cancel(session);
            return;
        }
        if (command.kind === 'answer') {
            const id = command.payload.request_id;
            const response = command.payload.response;
            if (typeof id !== 'string' || !id)
                throw new Error('answer requires payload.request_id');
            if (typeof response === 'string') {
                await control.answer(session, id, response);
                return;
            }
            if (
                !Array.isArray(response) ||
                !response.every(
                    (entry) =>
                        Array.isArray(entry) &&
                        entry.every((choice) => typeof choice === 'string')
                )
            )
                throw new Error(
                    'answer requires payload.response as text or arrays of strings'
                );
            await control.answer(session, id, JSON.stringify(response));
            return;
        }
        const text = command.payload.text;
        if (typeof text !== 'string' || !text.trim())
            throw new Error(`${command.kind} requires payload.text`);
        const environment = await this.#continuation(context);
        await control.send(
            session,
            text,
            command.kind,
            environment,
            await this.#connection(context.run, environment)
        );
    }

    async outcomes(session: string, uploaded: string[]): Promise<WorkerOutcome[]> {
        const outcomes: WorkerOutcome[] = [];
        for (const id of await this.#sessions.ids(session)) {
            if (uploaded.includes(id)) continue;
            const run = await this.#options.services.runs.read(id);
            if (!RunStore.isTerminal(run.status) || !run.outcome_id) continue;
            const outcome = await this.#outcomes.read(run.outcome_id);
            const pullRequest = WorkerOutcomeArchive.pullRequest(outcome);
            outcomes.push({
                run: run.id,
                ...(pullRequest !== undefined ? { pullRequest } : {}),
                archive: () => this.#outcomes.pack(outcome),
            });
        }
        return outcomes;
    }

    async release(runId: string): Promise<void> {
        await this.#options.environment.release(runId);
    }

    async recover(
        active: Array<{ run_id: string; runtime: string; session_id: string | null }>
    ): Promise<void> {
        await this.#options.environment.releaseExcept(
            new Set(active.map((run) => run.run_id))
        );
    }

    /**
     * The connection a run uses: the one it was asked for, else the member's
     * most recent connection for the runner, else none, and the engine picks
     * from the keys it was sent. Only a run that uses the member's connection
     * gets its key, which replaces an organization key of the same name. A
     * sign-in that saved its own files is in the member's sign-ins, which a run
     * of theirs finds on either runtime.
     */
    async #connection(
        run: Omit<WorkerRunContext['run'], 'run_id'>,
        environment: Record<string, string | undefined>,
        keys?: Record<string, string>
    ): Promise<string | undefined> {
        const saved = run.member_id
            ? await this.#options.home.readMemberConnection(run.member_id, run.runner)
            : undefined;
        if (!saved) return run.connection ?? undefined;
        const connection = run.connection ?? saved.provider;
        if (connection.toLowerCase() === saved.provider && saved.variable) {
            environment[saved.variable] = saved.secret;
            if (keys) delete keys[saved.variable];
        }
        return connection;
    }

    #start(
        start: RunStart,
        directory: string,
        environment: Record<string, string | undefined>,
        keys: Record<string, string>,
        connection: string | undefined
    ) {
        return this.#options.services.launcher.start({
            workbench: packageAlias(start.session_id),
            task: start.task,
            directory,
            runtime: start.runtime,
            rawArgs: [],
            environmentOverrides: { file: keys, explicit: new Map() },
            allowHostDocker: false,
            allowUncheckedGpu: false,
            ...(connection ? { connection } : {}),
            environment,
        });
    }

    /**
     * A container run is limited, not refused, by the runtime's own check, so the
     * worker also refuses one that needs more CPUs or memory than the machine has.
     */
    #checkCapacity(manifest: WorkbenchManifest): void {
        const requirements = requirementsOf(manifest);
        const host = (this.#options.host ?? new NodeHost()).describe();
        if (requirements.cpu !== undefined && requirements.cpu > host.cpus)
            throw new Error(
                `Workbench ${manifest.name} needs ${requirements.cpu} CPUs; this worker has ${host.cpus}`
            );
        const memory = Math.floor(host.memoryBytes / 1024 ** 3);
        if (requirements.memory_gb !== undefined && requirements.memory_gb > memory)
            throw new Error(
                `Workbench ${manifest.name} needs ${requirements.memory_gb} GB of memory; this worker has ${memory} GB`
            );
    }

    async #runner(start: RunStart): Promise<string> {
        const resolved = await new WorkbenchResolver().resolve(
            packageAlias(start.session_id),
            { home: this.#options.home.root, savedOnly: true }
        );
        try {
            return resolved.workbench.manifest.runner;
        } finally {
            await resolved.cleanup();
        }
    }

    /**
     * The environment a continuation runs with: the original run's, bound
     * again while this process holds its start, or rebuilt from the saved
     * starting member after a restart, without the start's credentials.
     */
    async #continuation(
        context: WorkerRunContext
    ): Promise<Record<string, string | undefined>> {
        const start = context.start;
        if (!start)
            return this.#options.environment.build(
                { ...context.run, image_pull: null, repository: {} },
                context.run.runner
            );
        const resolved = await new WorkbenchResolver().resolve(
            packageAlias(start.session_id),
            { home: this.#options.home.root, savedOnly: true }
        );
        try {
            const workbench = withRuntime(resolved.workbench, start.runtime);
            const inherited = await this.#options.environment.build(
                runSpec(start),
                workbench.manifest.runner
            );
            return new WorkbenchEnvironment(this.#options.runners).bind(
                workbench,
                { file: { ...start.env }, explicit: new Map() },
                inherited
            );
        } finally {
            await resolved.cleanup();
        }
    }
}

/**
 * The saved alias of a session's package in the worker home. It is per
 * session, not per version: a repository run's package carries a note about
 * its repository, so one version arrives with different bytes for different
 * runs, and a continuation must find exactly the package its session began.
 */
export function packageAlias(sessionId: string): string {
    const slug = sessionId
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
    if (!slug) throw new WorkerRejection('The run names an invalid session');
    return `session-${slug}`;
}

function message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
