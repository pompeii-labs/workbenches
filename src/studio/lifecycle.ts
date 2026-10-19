import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { basename } from 'node:path';

import type { StudioStateRecord, StudioStateStore } from '../database/studio/state.js';
import type { ProcessProbe } from '../processes/probe.js';
import type { RegistryClient } from '../registry/client.js';
import type { StudioDocker } from './docker.js';
import { type StudioHandoff, StudioOpenLink } from './openlink.js';
import type { StudioWakeSocket } from './wake.js';

/** The published Studio dashboard image, pinned by digest. */
export const DEFAULT_STUDIO_IMAGE =
    'ghcr.io/pompeii-labs/workbenches/studio:0.1.0@sha256:2261e08e03524de40f618e0f88aafaf0dd466448222dd72012feb2e0e80c21e2';
export const DEFAULT_STUDIO_PORT = 9_292;
export const DEFAULT_STUDIO_API_PORT = 9_293;

export interface StudioStatus {
    running: boolean;
    url: string | null;
    image: string;
    image_id: string | null;
    open_url?: string;
}

/** Opens a local file in the browser; false when no browser was opened. */
export interface StudioOpener {
    open(path: string): Promise<boolean>;
}

export interface StudioStartOptions {
    image: string;
    uiPort: number;
    apiPort: number;
    open: boolean;
}

/** Starts, reports, and stops the local Studio API process and dashboard container. */
export class StudioLifecycle {
    constructor(
        private readonly home: string,
        private readonly state: StudioStateStore,
        private readonly handoff: StudioHandoff,
        private readonly docker: StudioDocker,
        private readonly wake: Pick<StudioWakeSocket, 'remove'>,
        private readonly registry: Pick<RegistryClient, 'apiUrl'>,
        private readonly probe: Pick<ProcessProbe, 'alive'>,
        private readonly opener: StudioOpener,
        private readonly now: () => number
    ) {}

    async start(options: StudioStartOptions): Promise<StudioStatus> {
        await this.handoff.clear();
        const existing = this.state.read();
        if (existing) {
            const imageId = this.runningImage(existing);
            if (imageId !== undefined)
                return this.openStudio(existing, imageId || null, options.open);
            await this.docker.assertReady();
            await this.stop();
        }
        if (options.uiPort === options.apiPort)
            throw new Error('Studio UI and API ports must be different');
        await assertPortAvailable(options.uiPort, '--port');
        await assertPortAvailable(options.apiPort, '--api-port');
        if (!existing) await this.docker.assertReady();
        const imageId = await this.docker.resolveImage(options.image);
        const record: StudioStateRecord = {
            server_pid: 0,
            api_port: options.apiPort,
            ui_port: options.uiPort,
            container_id: '',
            token: randomBytes(32).toString('hex'),
            image: options.image,
            created_at: new Date().toISOString(),
        };
        let child: Bun.Subprocess | undefined;
        let containerId = '';
        try {
            this.state.write(record);
            child = Bun.spawn(this.serverCommand(), {
                cwd: process.cwd(),
                env: { ...process.env, WORKBENCH_HOME: this.home },
                stdin: 'ignore',
                stdout: 'ignore',
                stderr: 'ignore',
                detached: true,
            });
            child.unref();
            record.server_pid = child.pid;
            this.state.write(record);
            await this.waitForServer(record);
            await this.docker.prepareNetwork();
            containerId = await this.docker.runContainer(record, imageId);
            record.container_id = containerId;
            this.state.write(record);
            return await this.openStudio(record, imageId, options.open);
        } catch (error) {
            if (containerId)
                await this.docker.removeContainer(containerId).catch(() => {});
            if (child) await this.stopProcess(child.pid);
            await this.docker.removeNetwork().catch(() => {});
            this.state.clear();
            throw error;
        }
    }

    async stop(): Promise<StudioStatus> {
        const record = this.state.read();
        if (!record) return stopped(DEFAULT_STUDIO_IMAGE);
        let failure: Error | undefined;
        if (record.container_id) {
            try {
                await this.docker.removeContainer(record.container_id);
            } catch (error) {
                failure =
                    error instanceof Error ? error : new Error('Docker remove failed');
            }
        }
        try {
            await this.docker.removeNetwork();
        } catch (error) {
            failure ??=
                error instanceof Error
                    ? error
                    : new Error('Docker network remove failed');
        }
        await this.stopProcess(record.server_pid);
        await this.wake.remove();
        await this.handoff.clear();
        this.state.clear();
        if (failure) throw failure;
        return status(record, false, null);
    }

    status(): StudioStatus {
        const record = this.state.read();
        const imageId = record ? this.runningImage(record) : undefined;
        if (!record || imageId === undefined)
            return stopped(record?.image ?? DEFAULT_STUDIO_IMAGE);
        return status(record, true, imageId || null);
    }

    /** The detached API server command, which carries the API URL this process uses. */
    serverCommand(): string[] {
        const executable = process.execPath;
        const api = ['--api-url', this.registry.apiUrl];
        return basename(executable).startsWith('bun')
            ? [executable, Bun.main, '__studio', this.home, ...api]
            : [executable, '__studio', this.home, ...api];
    }

    // The open code reaches a browser only through a handoff file, never argv.
    private async openStudio(
        record: StudioStateRecord,
        imageId: string | null,
        open: boolean
    ): Promise<StudioStatus> {
        const started = status(record, true, imageId);
        const link = new StudioOpenLink(record.token, this.now).url(record.ui_port);
        if (open && (await this.opener.open(await this.handoff.write(link))))
            return started;
        await this.handoff.clear();
        return { ...started, open_url: link };
    }

    private async waitForServer(record: StudioStateRecord): Promise<void> {
        const started = Date.now();
        while (Date.now() - started < 5_000) {
            if (!this.probe.alive(record.server_pid))
                throw new Error('Studio API server exited during startup');
            const response = await fetch(
                `http://127.0.0.1:${record.api_port}/v1/status`,
                {
                    headers: {
                        Host: `127.0.0.1:${record.api_port}`,
                        Authorization: `Bearer ${record.token}`,
                    },
                }
            ).catch(() => undefined);
            if (response?.ok) return;
            await Bun.sleep(25);
        }
        throw new Error('Studio API server did not start in time');
    }

    private async stopProcess(pid: number): Promise<void> {
        if (!pid) return;
        signal(pid, 'SIGTERM');
        const started = Date.now();
        while (this.probe.alive(pid) && Date.now() - started < 2_000) {
            await Bun.sleep(25);
        }
        if (this.probe.alive(pid)) signal(pid, 'SIGKILL');
    }

    // The running container's image ID, or undefined when Studio is stopped.
    private runningImage(record: StudioStateRecord): string | undefined {
        if (!this.probe.alive(record.server_pid) || !record.container_id)
            return undefined;
        return this.docker.runningImage(record.container_id);
    }
}

function signal(pid: number, name: NodeJS.Signals): void {
    try {
        process.kill(pid, name);
    } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH'))
            throw error;
    }
}

async function assertPortAvailable(port: number, flag: string): Promise<void> {
    const available = await new Promise<boolean>((resolve) => {
        const server = createServer();
        server.once('error', () => resolve(false));
        server.listen(port, '127.0.0.1', () => {
            server.close((error) => resolve(!error));
        });
    });
    if (!available)
        throw new Error(`Port ${port} is in use. Free it or pass ${flag} <port>.`);
}

function stopped(image: string): StudioStatus {
    return { running: false, url: null, image, image_id: null };
}

function status(
    record: StudioStateRecord,
    running: boolean,
    imageId: string | null
): StudioStatus {
    return {
        running,
        url: running ? `http://127.0.0.1:${record.ui_port}` : null,
        image: record.image,
        image_id: running ? imageId : null,
    };
}
