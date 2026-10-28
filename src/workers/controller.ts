import { basename } from 'node:path';

import { RegistryClient } from '../registry/client.js';
import { WorkerApi } from './api.js';
import {
    WorkerHome,
    type WorkerSettings,
    type WorkerState,
    type WorkerStopMode,
} from './home.js';
import { WorkerRuntimeOffer, type WorkerRuntimes } from './offer.js';
import { isWorkerRuntime, type WorkerRuntime } from './protocol.js';
import { WorkerRegistration } from './registration.js';
import { type WorkerService, workerService } from './service.js';

export interface WorkerStatus {
    registered: boolean;
    name?: string;
    organization?: string;
    online: boolean;
    running: boolean;
    since?: string;
    slots?: number;
    runtimes?: WorkerRuntime[];
    runs: WorkerState['runs'];
    stopping: WorkerStopMode | null;
    stopped?: string;
}

export interface WorkerControllerDependencies {
    service?: () => WorkerService;
    offer?: Pick<WorkerRuntimeOffer, 'check'>;
    alive?: (pid: number) => boolean;
    wait?: (milliseconds: number) => Promise<void>;
    /** The command line that starts the daemon for a Workbench home. */
    daemonCommand?: (home: string, apiUrl: string) => string[];
}

/** Starts, stops, inspects, and removes this machine's worker for the CLI. */
export class WorkerController {
    readonly home: WorkerHome;
    readonly #service: () => WorkerService;
    readonly #offer: Pick<WorkerRuntimeOffer, 'check'>;
    readonly #alive: (pid: number) => boolean;
    readonly #wait: (milliseconds: number) => Promise<void>;
    readonly #daemonCommand: (home: string, apiUrl: string) => string[];

    constructor(
        private readonly workbenchHome: string,
        dependencies: WorkerControllerDependencies = {}
    ) {
        this.home = new WorkerHome(workbenchHome);
        this.#service = dependencies.service ?? (() => workerService());
        this.#offer = dependencies.offer ?? new WorkerRuntimeOffer();
        this.#alive = dependencies.alive ?? processAlive;
        this.#wait = dependencies.wait ?? ((milliseconds) => Bun.sleep(milliseconds));
        this.#daemonCommand = dependencies.daemonCommand ?? daemonCommand;
    }

    registration(): WorkerRegistration {
        return new WorkerRegistration(
            this.home,
            new WorkerApi(RegistryClient.configuredApiUrl())
        );
    }

    /** Parses `--runtimes` and `--slots`, keeping saved values for what is not given. */
    async settings(options: {
        runtimes?: string;
        slots?: string;
    }): Promise<WorkerSettings> {
        const saved = await this.home.readSettings();
        const runtimes = options.runtimes
            ? [...new Set(options.runtimes.split(',').map((entry) => entry.trim()))]
            : saved.runtimes;
        for (const runtime of runtimes) {
            if (!isWorkerRuntime(runtime))
                throw new Error(
                    `A worker offers docker or local, not ${runtime || 'nothing'}`
                );
        }
        const slots = options.slots === undefined ? saved.slots : Number(options.slots);
        if (!Number.isSafeInteger(slots) || slots < 1 || slots > 64)
            throw new Error('--slots must be a whole number from 1 to 64');
        return { runtimes: runtimes.filter(isWorkerRuntime), slots };
    }

    /**
     * Installs and starts the background service, then waits briefly for the
     * daemon to come online. Resolves the state it reached and what this
     * machine offers of the allowed runtimes; the daemon checks the same again
     * whenever it starts.
     */
    async start(
        settings: WorkerSettings,
        options: { onlineTimeoutMilliseconds?: number } = {}
    ): Promise<{ online: boolean; offer: WorkerRuntimes }> {
        const service = this.#service();
        const registration = await this.home.requireRegistration();
        const offer = await this.#offer.check(settings.runtimes);
        if (!offer.runtimes.length)
            throw new Error(
                'This worker has no runtime to offer: Docker is not running'
            );
        await this.home.saveSettings(settings);
        await this.home.clearStopRequest();
        const before = (await this.home.readState())?.started_at;
        await this.home.ensure();
        await service.install({
            command: this.#daemonCommand(this.workbenchHome, registration.api_url),
            // The daemon finds Docker and runner CLIs on the PATH of the shell that started it.
            environment: { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin' },
            outputPath: `${this.home.root}/daemon.out`,
        });
        const deadline = Date.now() + (options.onlineTimeoutMilliseconds ?? 10_000);
        while (Date.now() < deadline) {
            const state = await this.home.readState();
            if (state && state.started_at !== before && state.online)
                return { online: true, offer };
            await this.#wait(250);
        }
        return { online: false, offer };
    }

    async status(): Promise<WorkerStatus> {
        const registration = await this.home.readRegistration();
        const state = await this.home.readState();
        const running = state !== undefined && this.#alive(state.pid) && !state.stopped;
        return {
            registered: Boolean(registration),
            ...(registration
                ? { name: registration.name, organization: registration.organization }
                : {}),
            online: running && Boolean(state?.online),
            running,
            ...(state?.changed_at ? { since: state.changed_at } : {}),
            ...(state ? { slots: state.slots, runtimes: state.runtimes } : {}),
            runs: running ? (state?.runs ?? []) : [],
            stopping: running ? (state?.stopping ?? null) : null,
            ...(state?.stopped ? { stopped: state.stopped } : {}),
        };
    }

    /**
     * Stops the worker. Without `now` the daemon takes no new runs and exits
     * once its runs finish; with `now` it cancels them first. The service is
     * then stopped so it does not start again at boot.
     */
    async stop(
        mode: WorkerStopMode,
        onWaiting?: (runs: number) => void
    ): Promise<void> {
        const service = this.#service();
        const state = await this.home.readState();
        if (state && this.#alive(state.pid) && !state.stopped) {
            await this.home.requestStop(mode);
            let reported = -1;
            for (;;) {
                const current = await this.home.readState();
                if (!current || current.pid !== state.pid || !this.#alive(state.pid))
                    break;
                if (current.runs.length !== reported) {
                    reported = current.runs.length;
                    if (reported) onWaiting?.(reported);
                }
                await this.#wait(500);
            }
        }
        await service.stop();
        await this.home.clearStopRequest();
    }

    async remove(
        mode: WorkerStopMode,
        onWaiting?: (runs: number) => void
    ): Promise<string> {
        await this.home.requireRegistration();
        await this.stop(mode, onWaiting);
        await this.#service().uninstall();
        const registration = await this.home.requireRegistration();
        await new WorkerRegistration(
            this.home,
            new WorkerApi(registration.api_url)
        ).remove();
        return registration.name;
    }
}

/** The command a service runs to start the daemon, through Bun when wb runs from source. */
function daemonCommand(home: string, apiUrl: string): string[] {
    const executable = process.execPath;
    const args = ['__worker-daemon', home, '--api-url', apiUrl];
    return basename(executable).startsWith('bun')
        ? [executable, Bun.main, ...args]
        : [executable, ...args];
}

function processAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (
            typeof error === 'object' &&
            error !== null &&
            Reflect.get(error, 'code') === 'EPERM'
        );
    }
}
