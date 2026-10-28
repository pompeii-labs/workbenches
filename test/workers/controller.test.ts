import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { WorkerApi } from '../../src/workers/api.js';
import { WorkerController } from '../../src/workers/controller.js';
import { WorkerDaemon } from '../../src/workers/daemon.js';
import { WorkerHome } from '../../src/workers/home.js';
import { WorkerLog } from '../../src/workers/log.js';
import type { WorkerService } from '../../src/workers/service.js';
import { FakeRunHost, FakeWorkerServer, runStart, WORKER_KEY } from './fixture.js';

setDefaultTimeout(20_000);

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A worker home with a daemon running in this process against a server that never acknowledges. */
async function worker() {
    const directory = await mkdtemp(join(tmpdir(), 'workbench-worker-controller-'));
    const server = new FakeWorkerServer();
    server.routes.set(
        'DELETE /v1/workers/self',
        () => new Response(null, { status: 204 })
    );
    const home = new WorkerHome(directory);
    const registration = {
        version: 1 as const,
        id: 'wrk_1',
        slug: 'mini',
        name: 'mini',
        organization: 'acme',
        key: WORKER_KEY,
        api_url: server.url,
        registered_at: new Date().toISOString(),
    };
    await home.saveRegistration(registration);
    const host = new FakeRunHost();
    const daemon = new WorkerDaemon({
        home,
        registration,
        settings: { runtimes: ['docker'], slots: 1 },
        host,
        api: new WorkerApi(server.url),
        machine: {
            describe: async () => ({
                os: 'linux',
                arch: 'x64',
                cpus: 8,
                memory_gb: 16,
                gpus: [],
                docker: { version: '27.3.1' },
                runners: [],
            }),
        },
        log: new WorkerLog(home, 'mini'),
        version: '1.4.0',
        tickMilliseconds: 10,
        backoff: () => 20,
        acknowledgeMilliseconds: 200,
    });
    let exited = false;
    const running = daemon.run().finally(() => {
        exited = true;
    });
    const calls: string[] = [];
    const service: WorkerService = {
        kind: 'fake',
        install: async () => {
            calls.push('install');
        },
        stop: async () => {
            calls.push('stop');
        },
        running: async () => !exited,
        uninstall: async () => {
            calls.push('uninstall');
        },
    };
    const controller = new WorkerController(directory, {
        service: () => service,
        alive: () => !exited,
        wait: (milliseconds) => Bun.sleep(Math.min(milliseconds, 20)),
    });
    cleanups.push(async () => {
        daemon.terminate();
        await running;
        server.stop();
        await rm(directory, { recursive: true, force: true });
    });
    return { server, home, host, controller, calls, running };
}

describe('worker controller', () => {
    test('remove stops a busy worker with --now, then revokes its key', async () => {
        const { server, home, controller, calls, running } = await worker();
        await server.next((message) => message.type === 'hello');
        server.send(runStart());
        await server.next((message) => message.type === 'run.accepted');
        while ((await home.readState())?.runs.length !== 1) await Bun.sleep(10);
        const waiting: number[] = [];
        const name = await Promise.race([
            controller.remove('now', (runs) => waiting.push(runs)),
            Bun.sleep(5000).then(() => 'timed out'),
        ]);
        expect(name).toBe('mini');
        expect(await running).toBe(0);
        expect(waiting).toEqual([1]);
        expect(calls).toEqual(['stop', 'uninstall']);
        expect(server.requests.at(-1)).toMatchObject({
            method: 'DELETE',
            path: '/v1/workers/self',
            authorization: `Bearer ${WORKER_KEY}`,
        });
        expect(await home.readRegistration()).toBeUndefined();
    });
});
