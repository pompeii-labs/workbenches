import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
    isRecord,
    isWorkerRuntime,
    WORKER_RUNTIMES,
    type WorkerRuntime,
} from './protocol.js';

/** The worker key and identity registration stores. The key is a secret. */
export interface WorkerRegistrationRecord {
    version: 1;
    id: string;
    slug: string;
    name: string;
    organization: string;
    key: string;
    api_url: string;
    registered_at: string;
}

export interface WorkerSettings {
    /** The runtimes the worker may offer, of those this machine can run. */
    runtimes: WorkerRuntime[];
    slots: number;
}

export interface WorkerRunSummary {
    run_id: string;
    session_id: string;
    workbench: string;
    runtime: WorkerRuntime;
    state: string;
    started_at: string;
}

/** What the running daemon reports about itself for `wb worker status`. */
export interface WorkerState {
    pid: number;
    name: string;
    started_at: string;
    online: boolean;
    changed_at: string;
    slots: number;
    runtimes: WorkerRuntime[];
    runs: WorkerRunSummary[];
    stopping: WorkerStopMode | null;
    /** Why the daemon stopped on its own, such as a revoked key. */
    stopped?: string;
}

export type WorkerStopMode = 'drain' | 'now';

/** How a member connected a runner on this worker. */
export interface WorkerMemberConnection {
    /** The provider, as `wb connect` names it, which their runs ask for. */
    provider: string;
    /** The id of the method they chose. */
    method: string;
    /** The variable a saved key reaches their runs as. */
    variable?: string;
    /** That key. */
    secret?: string;
}

/**
 * The worker's own engine home, separate from the account's personal runs,
 * projects, and Studio. It holds the worker key, settings, the daemon's state
 * and lifecycle log, and one directory per member, which is the home of
 * their local runs and holds their runner sign-ins. Every file is written
 * owner-only.
 */
export class WorkerHome {
    readonly root: string;

    constructor(home: string) {
        this.root = join(home, 'worker');
    }

    get logPath(): string {
        return join(this.root, 'worker.log');
    }

    get assignmentsPath(): string {
        return join(this.root, 'assignments.json');
    }

    /** A member's directory: the home of their local runs, with their runner sign-ins. */
    memberDirectory(memberId: string): string {
        return join(this.root, 'members', WorkerHome.validIdentifier(memberId));
    }

    /** The empty home a local run without a member runs in, so it never reads the account's sign-ins. */
    get anonymousDirectory(): string {
        return join(this.root, 'members', '_none');
    }

    workspaceDirectory(runId: string): string {
        return join(this.root, 'workspaces', WorkerHome.validIdentifier(runId));
    }

    /** A docker run's own Docker client configuration, holding only its pull credential. */
    dockerConfigDirectory(runId: string): string {
        return join(this.root, 'docker', WorkerHome.validIdentifier(runId));
    }

    /**
     * Member and run ids become directory names, so only plain identifier
     * characters are accepted and nothing can climb out of the worker home.
     */
    static validIdentifier(id: string): string {
        if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id))
            throw new Error(`Invalid worker identifier: ${id}`);
        return id;
    }

    async ensure(directory = this.root): Promise<string> {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await chmod(directory, 0o700);
        return directory;
    }

    async readRegistration(): Promise<WorkerRegistrationRecord | undefined> {
        const value = await this.read('worker.json');
        if (value === undefined) return undefined;
        if (
            !isRecord(value) ||
            value.version !== 1 ||
            ![
                'id',
                'slug',
                'name',
                'organization',
                'key',
                'api_url',
                'registered_at',
            ].every((field) => typeof value[field] === 'string')
        )
            throw new Error(
                `Worker registration is unreadable: ${join(this.root, 'worker.json')}`
            );
        return {
            version: 1,
            id: String(value.id),
            slug: String(value.slug),
            name: String(value.name),
            organization: String(value.organization),
            key: String(value.key),
            api_url: String(value.api_url),
            registered_at: String(value.registered_at),
        };
    }

    async requireRegistration(): Promise<WorkerRegistrationRecord> {
        const registration = await this.readRegistration();
        if (!registration)
            throw new Error(
                'This machine is not registered as a worker. Run wb worker start --name <name>'
            );
        return registration;
    }

    async saveRegistration(record: WorkerRegistrationRecord): Promise<void> {
        await this.write('worker.json', record);
    }

    async removeRegistration(): Promise<void> {
        await rm(join(this.root, 'worker.json'), { force: true });
    }

    async readSettings(): Promise<WorkerSettings> {
        const value = await this.read('settings.json');
        const runtimes =
            isRecord(value) && Array.isArray(value.runtimes)
                ? value.runtimes.filter(
                      (runtime): runtime is WorkerRuntime =>
                          typeof runtime === 'string' && isWorkerRuntime(runtime)
                  )
                : [];
        const slots =
            isRecord(value) &&
            typeof value.slots === 'number' &&
            Number.isSafeInteger(value.slots) &&
            value.slots > 0
                ? value.slots
                : 1;
        return { runtimes: runtimes.length ? runtimes : [...WORKER_RUNTIMES], slots };
    }

    async saveSettings(settings: WorkerSettings): Promise<void> {
        await this.write('settings.json', settings);
    }

    async readState(): Promise<WorkerState | undefined> {
        const value = await this.read('state.json');
        if (!isRecord(value) || typeof value.pid !== 'number') return undefined;
        const runs = Array.isArray(value.runs) ? value.runs.filter(isRunSummary) : [];
        const stopping =
            value.stopping === 'drain' || value.stopping === 'now'
                ? value.stopping
                : null;
        return {
            pid: value.pid,
            name: typeof value.name === 'string' ? value.name : '',
            started_at: typeof value.started_at === 'string' ? value.started_at : '',
            online: value.online === true,
            changed_at: typeof value.changed_at === 'string' ? value.changed_at : '',
            slots: typeof value.slots === 'number' ? value.slots : 0,
            runtimes: Array.isArray(value.runtimes)
                ? value.runtimes.filter(
                      (runtime): runtime is WorkerRuntime =>
                          typeof runtime === 'string' && isWorkerRuntime(runtime)
                  )
                : [],
            runs,
            stopping,
            ...(typeof value.stopped === 'string' ? { stopped: value.stopped } : {}),
        };
    }

    async writeState(state: WorkerState): Promise<void> {
        await this.write('state.json', state);
    }

    async requestStop(mode: WorkerStopMode): Promise<void> {
        await this.write('control.json', {
            stop: mode,
            requested_at: new Date().toISOString(),
        });
    }

    async readStopRequest(): Promise<WorkerStopMode | undefined> {
        const value = await this.read('control.json');
        if (!isRecord(value)) return undefined;
        return value.stop === 'drain' || value.stop === 'now' ? value.stop : undefined;
    }

    async clearStopRequest(): Promise<void> {
        await rm(join(this.root, 'control.json'), { force: true });
    }

    /** The member a sign-in runs for, recorded so the log can name who started a run. */
    async saveMember(member: { id: string; name: string }): Promise<string> {
        const directory = await this.ensure(this.memberDirectory(member.id));
        await this.ensure(join(this.root, 'members'));
        await this.write(join('members', member.id, 'member.json'), member);
        return directory;
    }

    async readMember(id: string): Promise<{ id: string; name: string } | undefined> {
        const value = await this.read(
            join('members', WorkerHome.validIdentifier(id), 'member.json')
        );
        if (!isRecord(value) || typeof value.name !== 'string') return undefined;
        return { id, name: value.name };
    }

    /**
     * The connection a member made most recently for a runner on this
     * worker, which only that member's runs use. A key or a token a sign-in
     * printed is kept here as a secret; a sign-in that saves its own files
     * leaves only the provider and method.
     */
    async readMemberConnection(
        id: string,
        runner: string
    ): Promise<WorkerMemberConnection | undefined> {
        const value = await this.read(
            join('members', WorkerHome.validIdentifier(id), 'connections.json')
        );
        const entry = isRecord(value) ? value[runner] : undefined;
        if (
            !isRecord(entry) ||
            typeof entry.provider !== 'string' ||
            !entry.provider ||
            typeof entry.method !== 'string'
        )
            return undefined;
        return {
            provider: entry.provider,
            method: entry.method,
            ...(typeof entry.variable === 'string' &&
            entry.variable &&
            typeof entry.secret === 'string' &&
            entry.secret
                ? { variable: entry.variable, secret: entry.secret }
                : {}),
        };
    }

    async saveMemberConnection(
        id: string,
        runner: string,
        connection: WorkerMemberConnection
    ): Promise<void> {
        const name = join(
            'members',
            WorkerHome.validIdentifier(id),
            'connections.json'
        );
        const saved = await this.read(name);
        await this.write(name, {
            ...(isRecord(saved) ? saved : {}),
            [runner]: connection,
        });
    }

    async read(name: string): Promise<unknown> {
        const text = await readFile(join(this.root, name), 'utf8').catch(
            (error: unknown) => {
                if (isRecord(error) && error.code === 'ENOENT') return undefined;
                throw error;
            }
        );
        if (text === undefined) return undefined;
        try {
            return JSON.parse(text);
        } catch {
            return undefined;
        }
    }

    /** Writes owner-only through a temporary file, so a reader never sees half a file. */
    async write(name: string, value: unknown): Promise<void> {
        await this.ensure();
        const target = join(this.root, name);
        const temporary = `${target}.${randomBytes(6).toString('hex')}.tmp`;
        try {
            await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
                mode: 0o600,
            });
            await rename(temporary, target);
        } finally {
            await rm(temporary, { force: true });
        }
    }
}

function isRunSummary(value: unknown): value is WorkerRunSummary {
    return (
        isRecord(value) &&
        typeof value.run_id === 'string' &&
        typeof value.session_id === 'string' &&
        typeof value.workbench === 'string' &&
        typeof value.runtime === 'string' &&
        isWorkerRuntime(value.runtime) &&
        typeof value.state === 'string' &&
        typeof value.started_at === 'string'
    );
}
