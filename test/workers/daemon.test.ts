import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { WorkerApi } from '../../src/workers/api.js';
import { WorkerDaemon } from '../../src/workers/daemon.js';
import { GIT_REFUSAL } from '../../src/workers/git.js';
import { WorkerHome, type WorkerSettings } from '../../src/workers/home.js';
import { WorkerLog } from '../../src/workers/log.js';
import type { WorkerMachine } from '../../src/workers/protocol.js';
import { FakeRunHost, FakeWorkerServer, runStart, WORKER_KEY } from './fixture.js';

setDefaultTimeout(20_000);

const machine: WorkerMachine = {
    os: 'linux',
    arch: 'x64',
    cpus: 8,
    memory_gb: 16,
    gpus: [],
    docker: { version: '27.3.1' },
    runners: [{ name: 'opencode', version: '1.2.3' }],
};

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function worker(
    settings: Partial<WorkerSettings> = {},
    options: {
        acknowledgeMilliseconds?: number;
        repositoryRefusal?: string;
    } = {},
    reuse?: { directory: string; host: FakeRunHost; server: FakeWorkerServer }
) {
    const directory =
        reuse?.directory ?? (await mkdtemp(join(tmpdir(), 'workbench-worker-daemon-')));
    const server = reuse?.server ?? new FakeWorkerServer();
    server.routes.set(
        'PUT /v1/runs/run_1/outcome',
        () => new Response(null, { status: 204 })
    );
    const home = new WorkerHome(directory);
    const host = reuse?.host ?? new FakeRunHost();
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
    const log = new WorkerLog(home, 'mini');
    const daemon = new WorkerDaemon({
        home,
        registration,
        settings: { runtimes: ['docker'], slots: 1, ...settings },
        host,
        api: new WorkerApi(server.url),
        machine: { describe: async () => machine },
        log,
        version: '1.4.0',
        tickMilliseconds: 10,
        backoff: () => 20,
        ...options,
    });
    const running = daemon.run();
    let stopped = false;
    const stop = async () => {
        if (stopped) return;
        stopped = true;
        daemon.terminate();
        await running;
    };
    cleanups.push(async () => {
        await stop();
        if (reuse) return;
        server.stop();
        await rm(directory, { recursive: true, force: true });
    });
    return { directory, server, home, host, daemon, running, log, stop };
}

describe('worker daemon', () => {
    test('says hello, comes online, and logs it', async () => {
        const { server } = await worker();
        const hello = await server.next((message) => message.type === 'hello');
        expect(hello).toMatchObject({
            protocol: 1,
            wb_version: '1.4.0',
            machine,
            runtimes: ['docker'],
            slots: 1,
            runs: [],
        });
        await server.next((message) => message.type === 'log');
        expect(server.logLines()).toEqual([
            'online, 1 slot, docker 27.3.1, runtimes docker',
        ]);
    });

    test('accepts a run, streams its events with sequences, and uploads its outcome', async () => {
        const { server, host, directory } = await worker();
        await server.next((message) => message.type === 'hello');
        server.send(runStart());
        await server.next(
            (message) => message.type === 'run.accepted' && message.run_id === 'run_1'
        );
        const session = 'wb_run1session';
        host.emit(session, 'input.requested', {
            id: 'req_1',
            kind: 'permission',
            action: 'bash',
            resources: ['npm install'],
            options: ['allow_once', 'reject'],
        });
        host.emit(session, 'input.accepted', { id: 'req_1', kind: 'permission' });
        host.finish(session, 12);
        const upload = await server.request(
            (request) =>
                request.method === 'PUT' && request.path === '/v1/runs/run_1/outcome'
        );
        expect(upload.authorization).toBe('Bearer MUST_NOT_RENDER_RUN_TOKEN');
        expect(upload.body).toBe('outcome-archive');
        await server.next(
            (message) =>
                message.type === 'log' &&
                (message.lines as Array<{ text: string }>).some((line) =>
                    line.text.includes('completed')
                )
        );
        const events = server.events('run_1');
        expect(
            events.map((event) => [event.sequence, event.type, event.run_id])
        ).toEqual([
            [1, 'run.started', 'run_1'],
            [2, 'input.requested', 'run_1'],
            [3, 'input.accepted', 'run_1'],
            [4, 'run.completed', 'run_1'],
        ]);
        const lines = server.logLines();
        expect(lines).toContain(
            'threejs-game started  run_1  "Build a pirate game with three.js"'
        );
        expect(lines).toContain(
            'threejs-game needs input  permission: bash "npm install"'
        );
        expect(
            lines.some((line) =>
                /^threejs-game completed in \d+s {2}PR #12$/.test(line)
            )
        ).toBe(true);
        // Run credentials and environment stay in memory.
        expect(await everyFile(directory)).not.toMatch(/MUST_NOT_RENDER/);
    });

    test('logs the cloud run id and names a member only when it knows them', async () => {
        const { server, host, home } = await worker({ slots: 2 });
        await home.saveMember({ id: 'mem_known', name: 'matty' });
        await server.next((message) => message.type === 'hello');
        server.send(runStart({ started_by: { member_id: 'mem_known' } }));
        await server.next(
            (message) => message.type === 'run.accepted' && message.run_id === 'run_1'
        );
        server.send(
            runStart({ run_id: 'run_2', started_by: { member_id: 'mem_other' } })
        );
        await server.next(
            (message) => message.type === 'run.accepted' && message.run_id === 'run_2'
        );
        expect(host.launched).toHaveLength(2);
        await waitFor(async () =>
            server.logLines().some((line) => line.includes('started  run_2'))
        );
        const started = server.logLines().filter((line) => line.includes(' started '));
        expect(started).toEqual([
            'threejs-game started  run_1  by matty  "Build a pirate game with three.js"',
            'threejs-game started  run_2  "Build a pirate game with three.js"',
        ]);
    });

    test('rejects runs it cannot take, with the reason', async () => {
        const { server, host, home } = await worker();
        await server.next((message) => message.type === 'hello');
        const reason = async (runId: string) =>
            (
                await server.next(
                    (message) =>
                        message.type === 'run.rejected' && message.run_id === runId
                )
            ).reason;

        server.send(
            runStart({ run_id: 'run_local', runtime: 'local', image_pull: null })
        );
        expect(await reason('run_local')).toBe(
            'This worker does not offer the local runtime. It offers docker'
        );

        host.refuse =
            'Workbench threejs-game cannot run on the docker runtime: requires 64 CPUs';
        server.send(runStart({ run_id: 'run_big' }));
        expect(await reason('run_big')).toContain('requires 64 CPUs');
        host.refuse = undefined;

        server.send(runStart({ run_id: 'run_1' }));
        await server.next((message) => message.type === 'run.accepted');
        server.send(runStart({ run_id: 'run_2' }));
        expect(await reason('run_2')).toBe('All 1 slots are busy');

        host.finish('wb_run1session');
        await waitFor(async () => (await home.readState())?.runs.length === 0);
        await home.requestStop('drain');
        await waitFor(
            async () => (await home.readState())?.stopping === 'drain' || false
        );
    });

    test('relays commands into session controls and reports each result', async () => {
        const { server, host } = await worker();
        await server.next((message) => message.type === 'hello');
        server.send(runStart());
        await server.next((message) => message.type === 'run.accepted');

        server.send({
            type: 'command',
            command_id: 'cmd_1',
            run_id: 'run_1',
            kind: 'steer',
            payload: { text: 'Use TypeScript' },
        });
        expect(
            await server.next(
                (message) =>
                    message.type === 'command.done' && message.command_id === 'cmd_1'
            )
        ).toMatchObject({ status: 'delivered' });
        expect(host.commands[0]).toMatchObject({
            session: 'wb_run1session',
            command: { kind: 'steer', payload: { text: 'Use TypeScript' } },
            start: { run_token: 'MUST_NOT_RENDER_RUN_TOKEN' },
        });

        host.failCommand = 'steer requires an active execution';
        server.send({
            type: 'command',
            command_id: 'cmd_2',
            run_id: 'run_1',
            kind: 'steer',
            payload: { text: 'x' },
        });
        expect(
            await server.next(
                (message) =>
                    message.type === 'command.done' && message.command_id === 'cmd_2'
            )
        ).toMatchObject({
            status: 'rejected',
            reason: 'steer requires an active execution',
        });
        host.failCommand = undefined;

        server.send({
            type: 'command',
            command_id: 'cmd_3',
            run_id: 'run_unknown',
            kind: 'cancel',
            payload: {},
        });
        expect(
            await server.next(
                (message) =>
                    message.type === 'command.done' && message.command_id === 'cmd_3'
            )
        ).toMatchObject({
            status: 'rejected',
            reason: 'This worker has no session for the run',
        });

        server.send({
            type: 'command',
            command_id: 'cmd_4',
            run_id: 'run_1',
            kind: 'cancel',
            payload: {},
        });
        await server.next(
            (message) =>
                message.type === 'command.done' && message.command_id === 'cmd_4'
        );
        await server.next(
            (message) =>
                message.type === 'events' &&
                (message.events as Array<{ type: string }>).some(
                    (event) => event.type === 'run.cancelled'
                )
        );
    });

    test('reconnects and resends every event after the stored sequence', async () => {
        const { server, host } = await worker();
        await server.next((message) => message.type === 'hello');
        server.send(runStart());
        await server.next((message) => message.type === 'run.accepted');
        const session = 'wb_run1session';
        host.emit(session, 'output.text', { text: 'one' });
        host.emit(session, 'output.text', { text: 'two' });
        await waitFor(async () => server.events('run_1').length === 3);
        server.send({ type: 'stored', run_id: 'run_1', sequence: 1 });
        await Bun.sleep(30);

        // The server keeps sequence 1 and loses the rest with the connection.
        server.welcome = () => ({
            type: 'welcome',
            worker: { id: 'wrk_1', slug: 'mini' },
            organization: 'acme',
            stored: [{ run_id: 'run_1', sequence: 1 }],
        });
        const before = server.received.length;
        server.close(1011, 'restart');
        host.emit(session, 'output.text', { text: 'three' });
        const hello = await server.next((message) => message.type === 'hello', before);
        expect(hello.connection).toBe(2);
        expect(hello.runs).toEqual([{ run_id: 'run_1', sequence: 4 }]);
        await waitFor(async () =>
            server.received
                .slice(before)
                .some(
                    (message) => message.type === 'events' && message.connection === 2
                )
        );
        const resent = server.received
            .slice(before)
            .filter((message) => message.type === 'events')
            .flatMap((message) =>
                (message.events as Array<{ sequence: number }>).map(
                    (event) => event.sequence
                )
            );
        expect(resent).toEqual([2, 3, 4]);
        await waitFor(async () =>
            server.logLines().some((line) => line.startsWith('reconnected'))
        );
        expect(
            server.logLines().find((line) => line.startsWith('reconnected'))
        ).toMatch(/^reconnected after \d+s offline, 2 events resent$/);
    });

    test('stops when the server revokes the key', async () => {
        const { server, running, home } = await worker();
        await server.next((message) => message.type === 'hello');
        await server.next((message) => message.type === 'log');
        server.close(4001, 'revoked');
        expect(await running).toBe(0);
        expect((await home.readState())?.stopped).toContain(
            'the worker key was revoked'
        );
        expect(server.connections).toBe(1);
        expect(await readFile(home.logPath, 'utf8')).toMatch(
            /^\[mini\] \d\d:\d\d:\d\d online, 1 slot, docker 27\.3\.1, runtimes docker\n\[mini\] \d\d:\d\d:\d\d stopped: the worker key was revoked/
        );
    });

    test('drains on stop: no new runs, exits once its run finishes', async () => {
        const { server, host, home, running } = await worker({ slots: 2 });
        await server.next((message) => message.type === 'hello');
        server.send(runStart());
        await server.next((message) => message.type === 'run.accepted');
        await home.requestStop('drain');
        await waitFor(
            async () => (await home.readState())?.stopping === 'drain' || false
        );
        server.send(runStart({ run_id: 'run_2' }));
        expect(
            await server.next(
                (message) =>
                    message.type === 'run.rejected' && message.run_id === 'run_2'
            )
        ).toMatchObject({ reason: 'The worker is stopping' });
        host.emit('wb_run1session', 'output.text', { text: 'still going' });
        await Bun.sleep(50);
        host.finish('wb_run1session');
        await server.next(
            (message) =>
                message.type === 'events' &&
                (message.events as Array<{ type: string }>).some(
                    (event) => event.type === 'run.completed'
                )
        );
        server.send({ type: 'stored', run_id: 'run_1', sequence: 3 });
        expect(await running).toBe(0);
    });

    test('cancels its runs on stop --now', async () => {
        const { server, host, home, running } = await worker();
        await server.next((message) => message.type === 'hello');
        server.send(runStart());
        await server.next((message) => message.type === 'run.accepted');
        await home.requestStop('now');
        await waitFor(async () =>
            host.commands.some((entry) => entry.command.kind === 'cancel')
        );
        await server.next(
            (message) =>
                message.type === 'events' &&
                (message.events as Array<{ type: string }>).some(
                    (event) => event.type === 'run.cancelled'
                )
        );
        server.send({ type: 'stored', run_id: 'run_1', sequence: 2 });
        expect(await running).toBe(0);
    });

    test('stop --now exits within the bound when the server never acknowledges', async () => {
        const { server, host, home, running } = await worker(
            {},
            { acknowledgeMilliseconds: 300 }
        );
        await server.next((message) => message.type === 'hello');
        server.send(runStart());
        await server.next((message) => message.type === 'run.accepted');
        await home.requestStop('now');
        await waitFor(async () =>
            host.commands.some((entry) => entry.command.kind === 'cancel')
        );
        await server.next(
            (message) =>
                message.type === 'events' &&
                (message.events as Array<{ type: string }>).some(
                    (event) => event.type === 'run.cancelled'
                )
        );
        const drained = Date.now();
        const exited = await Promise.race([running, Bun.sleep(3000).then(() => -1)]);
        expect(exited).toBe(0);
        expect(Date.now() - drained).toBeGreaterThanOrEqual(250);
        // The unacknowledged events stay on disk for the next start.
        expect(JSON.parse(await readFile(home.assignmentsPath, 'utf8'))).toMatchObject({
            runs: [{ run_id: 'run_1', state: 'cancelled', observed: 2 }],
        });
    });

    test('reports a run that fails to launch as one run.failed event', async () => {
        const { server, host } = await worker();
        await server.next((message) => message.type === 'hello');
        host.failLaunch = 'Docker image could not be pulled';
        server.send(runStart());
        await server.next((message) => message.type === 'run.accepted');
        await waitFor(async () => server.events('run_1').length === 1);
        expect(server.events('run_1')[0]).toMatchObject({
            run_id: 'run_1',
            sequence: 1,
            type: 'run.failed',
            data: { message: 'Docker image could not be pulled' },
        });
        // What the launch prepared is released.
        expect(host.released).toEqual(['run_1']);
    });

    test('refuses repository runs without git and still takes the others', async () => {
        const { server } = await worker(
            { slots: 2 },
            { repositoryRefusal: GIT_REFUSAL }
        );
        await server.next((message) => message.type === 'hello');
        server.send(
            runStart({
                run_id: 'run_repo',
                workspace: {
                    repository: 'acme/game',
                    url: 'https://api.example.test/acme/game.git',
                    ref: 'main',
                    branch: null,
                    credential: null,
                },
            })
        );
        expect(
            await server.next(
                (message) =>
                    message.type === 'run.rejected' && message.run_id === 'run_repo'
            )
        ).toMatchObject({ reason: GIT_REFUSAL });
        server.send(runStart());
        await server.next(
            (message) => message.type === 'run.accepted' && message.run_id === 'run_1'
        );
    });

    test('accepts repository runs when git is present', async () => {
        const { server } = await worker();
        await server.next((message) => message.type === 'hello');
        server.send(
            runStart({
                workspace: {
                    repository: 'acme/game',
                    url: 'https://api.example.test/acme/game.git',
                    ref: 'main',
                    branch: null,
                    credential: null,
                },
            })
        );
        await server.next(
            (message) => message.type === 'run.accepted' && message.run_id === 'run_1'
        );
    });

    test('launches a run once when its start is repeated during admission', async () => {
        const { server, host } = await worker({ slots: 2 });
        await server.next((message) => message.type === 'hello');
        let admit = () => {};
        host.admitting = new Promise((resolve) => {
            admit = resolve;
        });
        server.send(runStart());
        server.send(runStart());
        await waitFor(async () => host.admissions === 1);
        admit();
        await server.next((message) => message.type === 'run.accepted');
        await waitFor(async () => host.launched.length === 1);
        server.send(runStart());
        await waitFor(
            async () =>
                server.received.filter((message) => message.type === 'run.accepted')
                    .length === 2
        );
        expect(host.launched).toHaveLength(1);
        expect(host.admissions).toBe(1);
    });

    test('releases a finished run, and after a restart continues it as its member', async () => {
        const first = await worker();
        await first.server.next((message) => message.type === 'hello');
        first.server.send(
            runStart({
                runtime: 'docker',
                started_by: { member_id: 'mem_1' },
            })
        );
        await first.server.next((message) => message.type === 'run.accepted');
        first.host.finish('wb_run1session');
        await waitFor(async () => first.host.released.includes('run_1'));
        await first.stop();

        const before = first.server.received.length;
        const second = await worker({}, {}, first);
        await second.server.next((message) => message.type === 'hello', before);
        expect(second.host.recovered.at(-1)).toEqual([]);
        second.server.send({
            type: 'command',
            command_id: 'cmd_after_restart',
            run_id: 'run_1',
            kind: 'send',
            payload: { text: 'Add sound' },
        });
        await second.server.next(
            (message) =>
                message.type === 'command.done' &&
                message.command_id === 'cmd_after_restart'
        );
        const relayed = second.host.commands.at(-1);
        expect(relayed?.context).toEqual({
            run: {
                run_id: 'run_1',
                runtime: 'docker',
                member_id: 'mem_1',
                runner: 'opencode',
                connection: null,
            },
        });
    });
});

async function waitFor(check: () => Promise<boolean>, timeout = 5000): Promise<void> {
    const deadline = Date.now() + timeout;
    while (!(await check())) {
        if (Date.now() > deadline) throw new Error('Timed out waiting for the worker');
        await Bun.sleep(10);
    }
}

async function everyFile(directory: string): Promise<string> {
    const contents: string[] = [];
    for (const entry of await readdir(directory, {
        recursive: true,
        withFileTypes: true,
    })) {
        if (entry.isFile())
            // The daemon renames temporary files into place meanwhile.
            contents.push(
                await readFile(join(entry.parentPath, entry.name), 'utf8').catch(
                    () => ''
                )
            );
    }
    return contents.join('\n');
}
