import { afterEach, describe, expect, test } from 'bun:test';
import { createHmac, timingSafeEqual } from 'node:crypto';
import {
    chmod,
    mkdir,
    mkdtemp,
    readdir,
    readFile,
    rm,
    stat,
    writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { Connection } from '../src/database/connection.js';
import { OutcomeStore } from '../src/outcomes/store.js';
import { HostCommands } from '../src/processes/commands.js';
import { RegistryAccountStore } from '../src/registry/account-store.js';
import { RegistryClient } from '../src/registry/client.js';
import { RunControl } from '../src/runs/control.js';
import { RunStore } from '../src/runs/store.js';
import {
    STUDIO_CONTRACT,
    StudioDocker,
    studioContainerEnvironment,
    studioDockerRunArguments,
    studioNetworkCreateArguments,
} from '../src/studio/docker.js';
import {
    DEFAULT_STUDIO_API_PORT,
    DEFAULT_STUDIO_IMAGE,
    DEFAULT_STUDIO_PORT,
    StudioLifecycle,
    type StudioOpener,
} from '../src/studio/lifecycle.js';
import { StudioHandoff, StudioOpenLink } from '../src/studio/openlink.js';
import type { StudioServer } from '../src/studio/server.js';
import { isRecord } from '../src/studio/values.js';
import { StudioWakeSocket } from '../src/studio/wake.js';
import { Services } from '../src/workbench/services.js';

const OPEN_CODE = /^v1\.(\d{1,12})\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/;
const homes: string[] = [];
const servers: StudioServer[] = [];
const connections: Connection[] = [];
const wired = new Map<string, Services & { connection: Connection }>();

afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.stop()));
    wired.clear();
    for (const connection of connections.splice(0)) connection.close();
    await Promise.all(
        homes.splice(0).map((home) => rm(home, { recursive: true, force: true }))
    );
    RegistryClient.configureApiUrl(undefined);
});

/** The services of one test home, over a connection closed after the test. */
function open(home: string) {
    let services = wired.get(home);
    if (!services) {
        const connection = Connection.open(home);
        connections.push(connection);
        services = Object.assign(new Services(home, connection), { connection });
        wired.set(home, services);
    }
    return services;
}

/** A Studio lifecycle with a chosen platform, browser, and clock. */
function studioLifecycle(
    home: string,
    platform: NodeJS.Platform = 'darwin',
    opener: StudioOpener = { open: async () => false },
    now: () => number = Date.now
): StudioLifecycle {
    const services = open(home);
    return new StudioLifecycle(
        home,
        services.studioState,
        new StudioHandoff(home),
        new StudioDocker(home, platform, new HostCommands()),
        new StudioWakeSocket(home),
        services.registry,
        services.probe,
        opener,
        now
    );
}

/** Options for starting Studio on free ports without a browser. */
async function startOptions(image = 'test-studio:dev') {
    return {
        image,
        uiPort: await unusedPort(),
        apiPort: await unusedPort(),
        open: false,
    };
}

describe('studio API', () => {
    test('serves only tracked sessions and rejects invalid authorization and hosts', async () => {
        const home = await temporaryHome();
        await open(home).projects.create('Empty');
        const tracked = await seedSession(home, 'Demo');
        await seedSession(home);
        const server = open(home).studio.server('test-token', 0);
        servers.push(server);
        await server.start();

        expect((await request(server, '/v1/status')).status).toBe(200);
        expect(await (await request(server, '/v1/projects')).json()).toMatchObject({
            projects: [
                {
                    name: 'Demo',
                    counts: { needs_you: 0, running: 1, done: 0, failed: 0 },
                },
                {
                    name: 'Empty',
                    counts: { needs_you: 0, running: 0, done: 0, failed: 0 },
                    now: [],
                    waiting: [],
                    latest_done: null,
                },
            ],
        });
        expect(await (await request(server, '/v1/tasks')).json()).toMatchObject({
            tasks: [{ id: tracked.sessionId, project: 'Demo' }],
        });
        expect((await request(server, '/v1/tasks?project=Missing')).status).toBe(200);
        expect(
            await (await request(server, `/v1/tasks/${tracked.sessionId}`)).json()
        ).toMatchObject({
            task: { id: tracked.sessionId },
            runs: [{ id: tracked.runId }],
        });
        expect((await request(server, `/v1/runs/${tracked.runId}`)).status).toBe(200);
        expect(
            await (
                await request(
                    server,
                    `/v1/runs/${tracked.runId}/events?after=0&limit=1`
                )
            ).json()
        ).toMatchObject({ events: [{ sequence: 1 }], next: 1 });

        expect((await request(server, '/v1/status', '')).status).toBe(401);
        expect(
            (await request(server, '/v1/status', 'test-token', 'evil.test')).status
        ).toBe(403);
    });

    test('serves only allowlisted outcome media types inline', async () => {
        const home = await temporaryHome();
        const seeded = await seedSession(home, 'Demo');
        const runs = open(home).runs;
        const outcomes = new OutcomeStore(home);
        const declared = [
            ['page.html', 'text/html', null],
            ['image.svg', 'image/svg+xml', null],
            ['photo.png', 'image/png', 'image/png'],
            ['note.txt', 'text/plain', 'text/plain'],
            ['mixed.png', 'image/png; a=b, text/html', null],
            ['charset.png', 'image/png;charset=utf-8', 'image/png; charset=utf-8'],
            ['upper.png', 'IMAGE/PNG', 'image/png'],
            ['utf8.txt', 'text/plain; charset=utf-8', 'text/plain; charset=utf-8'],
            ['other.txt', 'text/plain; format=flowed', null],
        ] as const;
        const artifacts = await Promise.all(
            declared.map(async ([path, type], index) => ({
                id: `artifact_${index}`,
                name: path,
                path,
                content: await outcomes.putBytes('<script>alert(1)</script>', type),
            }))
        );
        const outcomeId = OutcomeStore.createId();
        await outcomes.commit(
            {
                version: 1,
                id: outcomeId,
                run_id: seeded.runId,
                created_at: new Date().toISOString(),
                completeness: 'complete',
                changesets: [],
                artifacts,
                links: [],
                warnings: [],
            },
            'present'
        );
        await runs.update(seeded.runId, { outcome_id: outcomeId });
        const server = open(home).studio.server('test-token', 0);
        servers.push(server);
        await server.start();

        const listing = await (
            await request(server, `/v1/runs/${seeded.runId}/outcome/files`)
        ).json();
        expect(listing).toMatchObject({
            files: declared.map(([, type]) => ({ media_type: type })),
        });
        for (const [path, , served] of declared) {
            const response = await request(
                server,
                `/v1/runs/${seeded.runId}/outcome/files/${path}`
            );
            expect(response.headers.get('content-type')).toBe(
                served ?? 'application/octet-stream'
            );
            expect(response.headers.get('content-disposition')).toBe(
                served ? null : 'attachment'
            );
            expect(response.headers.get('x-content-type-options')).toBe('nosniff');
            expect(response.headers.get('content-security-policy')).toBe(
                "sandbox; default-src 'none'"
            );
        }
        await outcomes.close();
    });

    test('serves outcomes, rejects traversal, and routes idempotent answers', async () => {
        const home = await temporaryHome();
        const seeded = await seedSession(home, 'Demo');
        const runs = open(home).runs;
        await runs.update(seeded.runId, { status: 'running', pid: process.pid });
        await runs.appendEvent(seeded.runId, {
            protocol: 0,
            run_id: seeded.runId,
            sequence: 2,
            timestamp: new Date().toISOString(),
            type: 'input.requested',
            runner: 'opencode',
            data: {
                id: 'permission-1',
                kind: 'permission',
                message: 'Allow command?',
                options: ['allow_once', 'reject'],
            },
        });
        const outcomes = new OutcomeStore(home);
        const content = await outcomes.putBytes('artifact body', 'text/plain');
        const outcomeId = OutcomeStore.createId();
        await outcomes.commit(
            {
                version: 1,
                id: outcomeId,
                run_id: seeded.runId,
                created_at: new Date().toISOString(),
                completeness: 'complete',
                changesets: [],
                artifacts: [
                    {
                        id: 'artifact_1',
                        name: 'Report',
                        path: 'reports/report.txt',
                        content,
                        description: 'Result report',
                    },
                ],
                links: [],
                warnings: [],
            },
            'present'
        );
        await runs.update(seeded.runId, { outcome_id: outcomeId });
        const server = open(home).studio.server('test-token', 0);
        servers.push(server);
        await server.start();

        expect(
            await (
                await request(server, `/v1/runs/${seeded.runId}/outcome/files`)
            ).json()
        ).toMatchObject({ files: [{ path: 'reports/report.txt', size: 13 }] });
        expect(
            await (
                await request(
                    server,
                    `/v1/runs/${seeded.runId}/outcome/files/reports/report.txt`
                )
            ).text()
        ).toBe('artifact body');
        expect(
            (
                await request(
                    server,
                    `/v1/runs/${seeded.runId}/outcome/files/%2e%2e/wb.db`
                )
            ).status
        ).not.toBe(200);

        const commandRequest = {
            method: 'POST',
            headers: {
                Host: `127.0.0.1:${server.port}`,
                Authorization: 'Bearer test-token',
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                kind: 'answer',
                payload: { request_id: 'permission-1', response: 'allow' },
                idempotency_key: 'answer-key',
            }),
        };
        const command = fetch(
            `http://127.0.0.1:${server.port}/v1/runs/${seeded.runId}/commands`,
            commandRequest
        );
        const simultaneous = fetch(
            `http://127.0.0.1:${server.port}/v1/runs/${seeded.runId}/commands`,
            commandRequest
        );
        const control = new RunControl(open(home).connection, seeded.runId);
        const pending = await control.receive();
        expect(pending?.permission).toEqual({
            id: 'permission-1',
            decision: 'allow_once',
        });
        if (!pending) throw new Error('Missing Studio control request');
        await control.resolve(pending, {
            outcome: 'accepted',
            disposition: 'delivered',
        });
        const first = await command;
        expect(first.status).toBe(202);
        const firstBody = await first.json();
        expect(firstBody).toMatchObject({ command: { status: 'accepted' } });
        expect(await (await simultaneous).json()).toEqual(firstBody);
        const repeated = await fetch(
            `http://127.0.0.1:${server.port}/v1/runs/${seeded.runId}/commands`,
            {
                method: 'POST',
                headers: {
                    Host: `127.0.0.1:${server.port}`,
                    Authorization: 'Bearer test-token',
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    kind: 'answer',
                    payload: { request_id: 'different', response: 'deny' },
                    idempotency_key: 'answer-key',
                }),
            }
        );
        expect(await repeated.json()).toEqual(firstBody);
        await outcomes.close();
    });

    test('returns the input receipt id as the queued command id', async () => {
        const home = await temporaryHome();
        const seeded = await seedSession(home, 'Demo');
        const runs = open(home).runs;
        await runs.update(seeded.runId, { status: 'running', pid: process.pid });
        const server = open(home).studio.server('test-token', 0);
        servers.push(server);
        await server.start();
        const send = () =>
            fetch(`http://127.0.0.1:${server.port}/v1/runs/${seeded.runId}/commands`, {
                method: 'POST',
                headers: {
                    Host: `127.0.0.1:${server.port}`,
                    Authorization: 'Bearer test-token',
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    kind: 'queue',
                    payload: { text: 'next step' },
                    idempotency_key: 'queue-key',
                }),
            });
        const response = send();
        // Stands in for the interactive worker: claim the request, record the
        // queued event with the request id as the worker does, then acknowledge.
        const control = new RunControl(open(home).connection, seeded.runId);
        const pending = await control.receive();
        if (!pending) throw new Error('Missing Studio control request');
        await runs.appendEvent(seeded.runId, {
            protocol: 0,
            run_id: seeded.runId,
            sequence: 3,
            timestamp: new Date().toISOString(),
            type: 'input.queued',
            runner: 'opencode',
            data: { id: pending.id, kind: pending.kind },
        });
        await control.resolve(pending, { outcome: 'accepted', disposition: 'queued' });
        const body = await (await response).json();
        const events = await runs.readEvents(seeded.runId);
        const queued = events.find((event) => event.type === 'input.queued');
        expect(body).toMatchObject({
            command: { id: pending.id, status: 'accepted' },
        });
        expect(isRecord(queued?.data) && queued.data.id).toBe(pending.id);
        expect(await (await send()).json()).toEqual(body);
    });

    test('shows the real question or permission as the waiting text', async () => {
        const cases: [
            Record<string, unknown>,
            'question.requested' | 'input.requested',
            string,
        ][] = [
            [
                {
                    id: 'q1',
                    questions: [
                        { question: 'Which harbor should the pirates raid first?' },
                    ],
                },
                'question.requested',
                'Which harbor should the pirates raid first?',
            ],
            [
                {
                    id: 'q2',
                    questions: [
                        { question: 'First?' },
                        { question: 'B' },
                        { question: 'C' },
                    ],
                },
                'question.requested',
                'First? (+2 more)',
            ],
            [
                { id: 'q3', questions: [{ question: `a\n${'x'.repeat(300)}` }] },
                'question.requested',
                `a ${'x'.repeat(137)}…`,
            ],
            [
                {
                    id: 'p1',
                    kind: 'permission',
                    action: 'bash',
                    resources: ['ls', '-la'],
                },
                'input.requested',
                'bash ls -la',
            ],
            [{ id: 'i1', prompt: 'Type a name' }, 'input.requested', 'Type a name'],
        ];
        for (const [data, type, expected] of cases) {
            const home = await temporaryHome();
            const seeded = await seedSession(home, 'Demo');
            const runs = open(home).runs;
            await runs.update(seeded.runId, { status: 'running', pid: process.pid });
            await runs.appendEvent(seeded.runId, {
                protocol: 0,
                run_id: seeded.runId,
                sequence: 2,
                timestamp: new Date().toISOString(),
                type,
                runner: 'opencode',
                data,
            });
            const server = open(home).studio.server('test-token', 0);
            servers.push(server);
            await server.start();
            const body = await (await request(server, '/v1/projects')).json();
            expect(body).toMatchObject({
                projects: [{ waiting: [{ text: expected }] }],
            });
        }
    });

    test('reports no outcome when the final outcome has no artifacts', async () => {
        const home = await temporaryHome();
        const seeded = await seedSession(home, 'Demo');
        const runs = open(home).runs;
        const outcomes = new OutcomeStore(home);
        const outcomeId = OutcomeStore.createId();
        await outcomes.commit(
            {
                version: 1,
                id: outcomeId,
                run_id: seeded.runId,
                created_at: new Date().toISOString(),
                completeness: 'complete',
                changesets: [],
                artifacts: [],
                links: [],
                warnings: [],
            },
            'present'
        );
        await runs.update(seeded.runId, {
            status: 'completed',
            finished_at: new Date().toISOString(),
            outcome_id: outcomeId,
        });
        const server = open(home).studio.server('test-token', 0);
        servers.push(server);
        await server.start();

        expect(await (await request(server, '/v1/projects')).json()).toMatchObject({
            projects: [{ latest_done: { has_outcome: false } }],
        });
        expect(
            await (await request(server, `/v1/runs/${seeded.runId}`)).json()
        ).toMatchObject({ outcome_size: null });
        await outcomes.close();
    });

    test('replays run events and wakes live sockets after another process commits', async () => {
        const home = await temporaryHome();
        const seeded = await seedSession(home, 'Demo');
        const server = open(home).studio.server('test-token', 0);
        servers.push(server);
        await server.start();

        const runSocket = webSocket(server, `/v1/runs/${seeded.runId}/events?after=0`);
        expect(await nextFrame(runSocket)).toMatchObject({
            type: 'run.started',
            sequence: 1,
        });
        runSocket.close();

        const live = webSocket(server, '/v1/live');
        expect(await nextFrame(live)).toMatchObject({ type: 'status' });
        const taskFrame = nextFrame(live);
        const child = Bun.spawn(
            [
                process.execPath,
                '-e',
                `import { Connection } from './src/database/connection.ts';
import { Services } from './src/workbench/services.ts';
const [home, id] = process.argv.slice(1);
const connection = Connection.open(home);
try {
    await new Services(home, connection).runs.appendEvent(id, { protocol: 0, run_id: id, sequence: 2, timestamp: new Date().toISOString(), type: 'output.text', runner: 'opencode', data: { id: 'message-1', text: 'separate worker output' } });
} finally {
    connection.close();
}`,
                home,
                seeded.runId,
            ],
            {
                cwd: process.cwd(),
                env: { ...process.env, WORKBENCH_HOME: home },
                stdout: 'pipe',
                stderr: 'pipe',
            }
        );
        expect(await child.exited).toBe(0);
        expect(await taskFrame).toMatchObject({
            type: 'task',
            task: { id: seeded.sessionId, project: 'Demo' },
        });
        live.close();
    });

    test('answers a WebSocket upgrade for an unknown run with JSON 404', async () => {
        const home = await temporaryHome();
        const server = open(home).studio.server('test-token', 0);
        servers.push(server);
        await server.start();

        const response = await fetch(
            `http://127.0.0.1:${server.port}/v1/runs/wb_missing0/events?after=0`,
            {
                headers: {
                    Host: `127.0.0.1:${server.port}`,
                    Authorization: 'Bearer test-token',
                    Connection: 'Upgrade',
                    Upgrade: 'websocket',
                    'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
                    'Sec-WebSocket-Version': '13',
                },
            }
        );
        expect(response.status).toBe(404);
        expect(response.headers.get('content-type')).toContain('application/json');
        const body = await response.text();
        expect(JSON.parse(body)).toMatchObject({ error: { code: 'not_found' } });
        expect(body).not.toContain(home);
        expect(body).not.toContain(process.cwd());
        expect(body).not.toMatch(/\bat \S+ \(|\.ts:\d+/);
    });
});

describe('studio lifecycle', () => {
    test('uses fixed default UI and API ports', () => {
        expect(DEFAULT_STUDIO_PORT).toBe(9292);
        expect(DEFAULT_STUDIO_API_PORT).toBe(9293);
    });

    const dummy = { api_port: 4001, ui_port: 4002, token: 'tok', image: 'img:test' };
    const imageId = `sha256:${'a'.repeat(64)}`;
    const hardening = [
        '--read-only',
        '--tmpfs',
        '/tmp',
        '--cap-drop',
        'ALL',
        '--security-opt',
        'no-new-privileges',
    ];

    test('runs the container on the host network on Linux', () => {
        expect(
            studioDockerRunArguments('linux', dummy, imageId, 'name', '/env')
        ).toEqual([
            'docker',
            'run',
            '--detach',
            '--name',
            'name',
            '--label',
            'dev.workbenches.studio=1',
            ...hardening,
            '--network',
            'host',
            '--env-file',
            '/env',
            imageId,
        ]);
        expect(studioContainerEnvironment('linux', dummy)).toBe(
            'WORKBENCH_STUDIO_API=http://127.0.0.1:4001\nWORKBENCH_STUDIO_LISTEN=127.0.0.1:4002\nWORKBENCH_STUDIO_TOKEN=tok\n'
        );
    });

    test('uses a labelled Studio bridge and host.docker.internal on Docker Desktop platforms', () => {
        expect(studioNetworkCreateArguments()).toEqual([
            'docker',
            'network',
            'create',
            '--driver',
            'bridge',
            '--label',
            'dev.workbenches.studio=1',
            'workbench-studio',
        ]);
        for (const platform of ['darwin', 'win32'] as const) {
            expect(
                studioDockerRunArguments(platform, dummy, imageId, 'name', '/env')
            ).toEqual([
                'docker',
                'run',
                '--detach',
                '--name',
                'name',
                '--label',
                'dev.workbenches.studio=1',
                ...hardening,
                '--network',
                'workbench-studio',
                '--publish',
                '127.0.0.1:4002:3000',
                '--add-host',
                'host.docker.internal:host-gateway',
                '--env-file',
                '/env',
                imageId,
            ]);
            expect(studioContainerEnvironment(platform, dummy)).toBe(
                'WORKBENCH_STUDIO_API=http://host.docker.internal:4001\nWORKBENCH_STUDIO_TOKEN=tok\n'
            );
        }
    });

    test('mints open codes that verify with the key derived from the token', () => {
        const now = 1_800_000_000_123;
        const link = new StudioOpenLink('studio-token', () => now);
        const first = link.code();
        const second = link.code();
        expect(first).not.toBe(second);
        for (const code of [first, second]) {
            const match = code.match(OPEN_CODE);
            expect(match).not.toBeNull();
            expect(match?.[1]).toBe(String(Math.floor(now / 1_000) + 300));
            expect(verifyOpenCode('studio-token', code)).toBeTrue();
            expect(verifyOpenCode('other-token', code)).toBeFalse();
        }
        expect(link.url(4002)).toMatch(
            /^http:\/\/127\.0\.0\.1:4002\/open\?code=v1\.\d+\.[\w-]{22}\.[\w-]{43}$/
        );
    });

    test('opens a running Studio with a fresh open code and never restarts it', async () => {
        const home = await temporaryHome();
        const bin = join(home, 'bin');
        const record = join(home, 'docker-record');
        await mkdir(bin);
        const docker = join(bin, 'docker');
        await writeFile(
            docker,
            `#!/bin/sh
printf '%s\n' "$*" >> "${record}"
if [ "$1" = "inspect" ]; then printf 'true ${imageId}\n'; exit 0; fi
if [ "$1" = "rm" ] || [ "$1" = "network" ]; then exit 0; fi
exit 1
`
        );
        await chmod(docker, 0o755);
        const apiServer = Bun.spawn(['sleep', '60'], { stdin: 'ignore' });
        open(home).studioState.write({
            server_pid: apiServer.pid,
            api_port: 4001,
            ui_port: 4002,
            container_id: 'studio-container',
            token: 'studio-token',
            image: 'img:test',
            created_at: new Date().toISOString(),
        });
        const now = 1_800_000_000_123;
        const handoffs = join(home, 'studio');
        const opened: {
            args: string[];
            page: string;
            mode: number;
            directoryMode: number;
        }[] = [];
        let launches = true;
        const previous = process.env.PATH;
        process.env.PATH = `${bin}:${previous ?? ''}`;
        try {
            const lifecycle = studioLifecycle(
                home,
                'darwin',
                {
                    open: async (...args: string[]) => {
                        const path = args[0] as string;
                        opened.push({
                            args,
                            page: await readFile(path, 'utf8'),
                            mode: (await stat(path)).mode & 0o777,
                            directoryMode: (await stat(handoffs)).mode & 0o777,
                        });
                        return launches;
                    },
                },
                () => now
            );
            const running = {
                running: true,
                url: 'http://127.0.0.1:4002',
                image: 'img:test',
                image_id: imageId,
            };
            const reopen = {
                image: DEFAULT_STUDIO_IMAGE,
                uiPort: DEFAULT_STUDIO_PORT,
                apiPort: DEFAULT_STUDIO_API_PORT,
                open: true,
            };
            expect(await lifecycle.start(reopen)).toEqual(running);
            const first = opened[0]?.args[0] as string;
            expect(await stat(first).catch(() => undefined)).toBeDefined();
            expect(await lifecycle.start(reopen)).toEqual(running);
            const second = opened[1]?.args[0] as string;
            expect(second).not.toBe(first);
            expect(await stat(first).catch(() => undefined)).toBeUndefined();
            expect(await readdir(handoffs)).toEqual([basename(second)]);
            const quiet = await lifecycle.start({ ...reopen, open: false });
            expect(await readdir(handoffs)).toEqual([]);
            launches = false;
            const failed = await lifecycle.start(reopen);
            expect(await readdir(handoffs)).toEqual([]);
            expect(opened).toHaveLength(3);
            const urls: string[] = [];
            for (const { args, page, mode, directoryMode } of opened) {
                expect(args).toHaveLength(1);
                expect(args[0]).toStartWith(`${handoffs}/`);
                expect(basename(args[0] as string)).toMatch(
                    /^studio-open-[a-f0-9]{32}\.html$/
                );
                expect(args[0]).not.toContain('code=');
                expect(mode).toBe(0o600);
                expect(directoryMode).toBe(0o700);
                expect(page).toStartWith('<!doctype html>');
                expect(page).toContain('<meta charset="utf-8">');
                expect(page).toContain('<meta name="referrer" content="no-referrer">');
                const refresh = page.match(
                    /<meta http-equiv="refresh" content="0;url=([^"]+)">/
                )?.[1] as string;
                expect(page).toContain(`<a href="${refresh}">`);
                urls.push(refresh);
            }
            expect(failed.open_url).toBe(urls[2]);
            expect(quiet.open_url).toBeString();
            urls.push(quiet.open_url as string);
            expect(new Set(urls).size).toBe(4);
            for (const url of urls) {
                const parsed = new URL(url);
                expect(`${parsed.origin}${parsed.pathname}`).toBe(
                    'http://127.0.0.1:4002/open'
                );
                const code = parsed.searchParams.get('code') ?? '';
                expect(verifyOpenCode('studio-token', code)).toBeTrue();
                expect(code.split('.')[1]).toBe(String(Math.floor(now / 1_000) + 300));
            }
            expect(lifecycle.status()).toEqual(running);
            const invocations = (await readFile(record, 'utf8')).trim().split('\n');
            expect(invocations.every((line) => line.startsWith('inspect '))).toBeTrue();
            launches = true;
            await lifecycle.start(reopen);
            expect(await readdir(handoffs)).toHaveLength(1);
            await lifecycle.stop();
            expect(await readdir(handoffs)).toEqual([]);
        } finally {
            process.env.PATH = previous;
            apiServer.kill('SIGKILL');
            await apiServer.exited;
        }
    });

    test('removes the Studio network on stop only off Linux and tolerates it in use', async () => {
        for (const platform of ['darwin', 'linux'] as const) {
            const home = await temporaryHome();
            const bin = join(home, 'bin');
            const record = join(home, 'docker-record');
            await mkdir(bin);
            const docker = join(bin, 'docker');
            await writeFile(
                docker,
                `#!/bin/sh
printf '%s\n' "$*" >> "${record}"
if [ "$1" = "network" ]; then echo 'Error response from daemon: error while removing network: network workbench-studio has active endpoints' >&2; exit 1; fi
exit 0
`
            );
            await chmod(docker, 0o755);
            open(home).studioState.write({
                server_pid: 0,
                api_port: 4001,
                ui_port: 4002,
                container_id: 'studio-container',
                token: 'studio-token',
                image: 'img:test',
                created_at: new Date().toISOString(),
            });
            const previous = process.env.PATH;
            process.env.PATH = `${bin}:${previous ?? ''}`;
            try {
                await expect(
                    studioLifecycle(home, platform).stop()
                ).resolves.toMatchObject({ running: false, image_id: null });
            } finally {
                process.env.PATH = previous;
            }
            expect((await readFile(record, 'utf8')).trim().split('\n')).toEqual(
                platform === 'linux'
                    ? ['rm --force studio-container']
                    : ['rm --force studio-container', 'network rm workbench-studio']
            );
        }
    });

    test('applies a non-default API URL in the studio child process', async () => {
        const home = await temporaryHome();
        const cloud = Bun.serve({
            hostname: '127.0.0.1',
            port: 0,
            fetch: () =>
                Response.json({ error: { message: 'Not found' } }, { status: 404 }),
        });
        const apiUrl = `http://127.0.0.1:${cloud.port}`;
        RegistryClient.configureApiUrl(apiUrl);
        const command = studioLifecycle(home).serverCommand();
        expect(command).toContain('__studio');
        expect(command).toContain('--api-url');
        expect(command).toContain(apiUrl);
        await new RegistryAccountStore({ home }).save(
            {
                organizationId: '00000000-0000-4000-8000-000000000001',
                slug: 'acme',
                name: 'Acme',
                personal: false,
                token: 'placeholder-studio-key',
                keyId: '00000000-0000-4000-8000-000000000002',
                scopes: ['projects:read'],
                expiresAt: '2099-01-01T00:00:00.000Z',
            },
            { makeDefault: true }
        );
        const apiPort = await unusedPort();
        open(home).studioState.write({
            server_pid: 0,
            api_port: apiPort,
            ui_port: await unusedPort(),
            container_id: '',
            token: 'placeholder-studio-token',
            image: 'test-studio:dev',
            created_at: new Date().toISOString(),
        });
        const child = Bun.spawn(
            [process.execPath, 'src/cli.ts', '__studio', home, '--api-url', apiUrl],
            {
                cwd: process.cwd(),
                env: { WORKBENCH_HOME: home, PATH: process.env.PATH ?? '' },
                stdout: 'pipe',
                stderr: 'pipe',
            }
        );
        try {
            let status: Response | undefined;
            const started = Date.now();
            while (!status?.ok && Date.now() - started < 5_000) {
                status = await fetch(`http://127.0.0.1:${apiPort}/v1/status`, {
                    headers: {
                        Host: `127.0.0.1:${apiPort}`,
                        Authorization: 'Bearer placeholder-studio-token',
                    },
                }).catch(() => undefined);
                if (!status?.ok) await Bun.sleep(25);
            }
            expect(status?.ok).toBeTrue();
            expect(await status?.json()).toMatchObject({
                login: { organization: 'acme' },
            });
        } finally {
            child.kill('SIGTERM');
            await child.exited;
            cloud.stop(true);
        }
    });

    test('starts, reports, and stops through the CLI without exposing its token', async () => {
        const home = await temporaryHome();
        const bin = join(home, 'bin');
        const record = join(home, 'docker-record');
        await mkdir(bin);
        const docker = join(bin, 'docker');
        await writeFile(
            docker,
            `#!/bin/sh
printf '%s\n' "$*" >> "$WB_DOCKER_RECORD"
if [ "$1" = "info" ]; then printf 'linux\n'; exit 0; fi
case "$*" in *dev.workbenches.studio.contract*) printf '${STUDIO_CONTRACT}\n'; exit 0;; esac
if [ "$1" = "image" ]; then printf '%s\n' ${imageId}; exit 0; fi
if [ "$1" = "network" ] && [ "$2" = "inspect" ]; then exit 1; fi
if [ "$1" = "network" ]; then exit 0; fi
if [ "$1" = "run" ]; then printf '%s\n' studio-container; exit 0; fi
if [ "$1" = "inspect" ]; then printf 'true ${imageId}\n'; exit 0; fi
if [ "$1" = "rm" ]; then exit 0; fi
exit 1
`
        );
        await chmod(docker, 0o755);
        const path = `${bin}:${process.env.PATH ?? ''}`;
        const environment = { WB_DOCKER_RECORD: record };
        const uiPort = await unusedPort();
        const apiPort = await unusedPort();

        const started = await cli(
            home,
            [
                'studio',
                '--no-open',
                '--json',
                '--image',
                'test-studio:dev',
                '--port',
                String(uiPort),
                '--api-port',
                String(apiPort),
            ],
            path,
            environment
        );
        expect(started.code).toBe(0);
        const { open_url: startedLink, ...startedStatus } = JSON.parse(started.stdout);
        expect(startedStatus).toEqual({
            running: true,
            url: `http://127.0.0.1:${uiPort}`,
            image: 'test-studio:dev',
            image_id: imageId,
        });
        expect(startedLink).toStartWith(`http://127.0.0.1:${uiPort}/open?code=v1.`);
        const repeated = await cli(
            home,
            ['studio', '--no-open', '--json'],
            path,
            environment
        );
        const { open_url: repeatedLink, ...repeatedStatus } = JSON.parse(
            repeated.stdout
        );
        expect(repeatedStatus).toEqual(startedStatus);
        expect(repeatedLink).toStartWith(`http://127.0.0.1:${uiPort}/open?code=v1.`);
        expect(repeatedLink).not.toBe(startedLink);
        const text = await cli(home, ['studio', '--no-open'], path, environment);
        expect(text.stdout).toStartWith(
            `Workbench Studio: http://127.0.0.1:${uiPort}\nOpen link (works once, within 5 minutes): http://127.0.0.1:${uiPort}/open?code=v1.`
        );
        const reported = await cli(
            home,
            ['studio', 'status', '--json'],
            path,
            environment
        );
        expect(JSON.parse(reported.stdout)).toEqual(startedStatus);
        const handoffs = join(home, 'studio');
        expect(await stat(handoffs).catch(() => undefined)).toBeUndefined();
        await mkdir(handoffs, { mode: 0o700 });
        const leftover = join(handoffs, `studio-open-${'a'.repeat(32)}.html`);
        await writeFile(leftover, '<!doctype html>', { mode: 0o600 });
        const stopped = await cli(
            home,
            ['studio', 'stop', '--json'],
            path,
            environment
        );
        expect(stopped.code).toBe(0);
        expect(JSON.parse(stopped.stdout)).toMatchObject({ running: false, url: null });
        expect(await readdir(handoffs)).toEqual([]);
        const invocations = await readFile(record, 'utf8');
        const lines = invocations.trim().split('\n');
        expect(invocations).toContain('dev.workbenches.studio=1');
        expect(invocations).not.toContain('WORKBENCH_STUDIO_TOKEN');
        const runs = lines.filter((line) => line.startsWith('run '));
        expect(runs).toHaveLength(1);
        const run = runs[0] as string;
        expect(run).toContain(
            '--read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges'
        );
        expect(run).toEndWith(` ${imageId}`);
        expect(lines.slice(0, 3)).toEqual([
            'info --format {{.OSType}}',
            'image inspect --format {{.Id}} test-studio:dev',
            `image inspect --format {{index .Config.Labels "dev.workbenches.studio.contract"}} ${imageId}`,
        ]);
        expect(lines.some((line) => line.startsWith('pull '))).toBeFalse();
        const networkLines = lines.filter((line) => line.startsWith('network '));
        if (process.platform === 'linux') {
            expect(run).toContain('--network host');
            expect(networkLines).toEqual([]);
        } else {
            expect(run).toContain(
                `--network workbench-studio --publish 127.0.0.1:${uiPort}:3000 --add-host host.docker.internal:host-gateway`
            );
            expect(networkLines).toEqual([
                'network inspect --format {{index .Labels "dev.workbenches.studio"}} workbench-studio',
                'network create --driver bridge --label dev.workbenches.studio=1 workbench-studio',
                'network rm workbench-studio',
            ]);
            expect(lines.indexOf(networkLines[1] as string)).toBeLessThan(
                lines.indexOf(run)
            );
            expect(lines.at(-1)).toBe('network rm workbench-studio');
        }
        for (const link of [startedLink, repeatedLink]) {
            const code = new URL(link).searchParams.get('code') as string;
            expect(invocations).not.toContain(code);
            expect(await readFile(join(home, 'wb.db'), 'latin1')).not.toContain(code);
        }
        expect(
            await stat(join(home, 'studio.sock')).catch(() => undefined)
        ).toBeUndefined();
    });

    test('fails before startup when a requested port is busy', async () => {
        const home = await temporaryHome();
        const bin = join(home, 'bin');
        const record = join(home, 'docker-record');
        await mkdir(bin);
        const docker = join(bin, 'docker');
        await writeFile(
            docker,
            '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$WB_DOCKER_RECORD"\nexit 0\n'
        );
        await chmod(docker, 0o755);
        const busy = createServer();
        await new Promise<void>((resolve) => busy.listen(0, '127.0.0.1', resolve));
        const address = busy.address();
        if (!address || typeof address === 'string') throw new Error('Missing port');
        const apiPort = await unusedPort();
        try {
            const result = await cli(
                home,
                [
                    'studio',
                    '--no-open',
                    '--port',
                    String(address.port),
                    '--api-port',
                    String(apiPort),
                ],
                `${bin}:${process.env.PATH ?? ''}`,
                { WB_DOCKER_RECORD: record }
            );
            expect(result.code).toBe(1);
            expect(result.stderr).toContain(
                `Port ${address.port} is in use. Free it or pass --port <port>.`
            );
            expect(studioLifecycle(home).status()).toEqual({
                running: false,
                url: null,
                image: DEFAULT_STUDIO_IMAGE,
                image_id: null,
            });
            expect(await stat(record).catch(() => undefined)).toBeUndefined();
            expect(
                await stat(join(home, 'studio.sock')).catch(() => undefined)
            ).toBeUndefined();
        } finally {
            await new Promise<void>((resolve, reject) =>
                busy.close((error) => (error ? reject(error) : resolve()))
            );
        }
    });

    test('reports an image it cannot pull without leaving state or a process', async () => {
        const home = await temporaryHome();
        const record = join(home, 'docker-record');
        const bin = await fakeDocker(
            home,
            record,
            `if [ "$1" = "info" ]; then printf 'linux\\n'; exit 0; fi
if [ "$1" = "pull" ]; then echo 'Error response from daemon: manifest unknown' >&2; exit 1; fi
exit 1`
        );
        const previous = process.env.PATH;
        process.env.PATH = `${bin}:${previous ?? ''}`;
        try {
            const lifecycle = studioLifecycle(home);
            const uiPort = await unusedPort();
            const apiPort = await unusedPort();
            await expect(
                lifecycle.start({
                    image: 'missing-studio:test',
                    uiPort,
                    apiPort,
                    open: false,
                })
            ).rejects.toThrow('Could not pull the Studio image missing-studio:test');
            expect(lifecycle.status()).toEqual({
                running: false,
                url: null,
                image: DEFAULT_STUDIO_IMAGE,
                image_id: null,
            });
            await expect(lifecycle.stop()).resolves.toEqual({
                running: false,
                url: null,
                image: DEFAULT_STUDIO_IMAGE,
                image_id: null,
            });
            const started = await cli(
                home,
                [
                    'studio',
                    '--no-open',
                    '--image',
                    'missing-studio:test',
                    '--port',
                    String(uiPort),
                    '--api-port',
                    String(apiPort),
                ],
                process.env.PATH,
                { WB_DOCKER_RECORD: record }
            );
            expect(started.code).toBe(1);
            expect(started.stderr).toContain('missing-studio:test');
            const reported = await cli(
                home,
                ['studio', 'status', '--json'],
                process.env.PATH
            );
            expect(reported.code).toBe(0);
            expect(JSON.parse(reported.stdout)).toEqual({
                running: false,
                url: null,
                image: DEFAULT_STUDIO_IMAGE,
                image_id: null,
            });
            const stopped = await cli(
                home,
                ['studio', 'stop', '--json'],
                process.env.PATH
            );
            expect(stopped.code).toBe(0);
            const lines = (await readFile(record, 'utf8')).trim().split('\n');
            expect(lines).toContain('pull missing-studio:test');
            expect(lines.some((line) => line.startsWith('run '))).toBeFalse();
        } finally {
            process.env.PATH = previous;
        }
    });

    test('pulls an image that is not local and runs it by its resolved ID', async () => {
        const home = await temporaryHome();
        const record = join(home, 'docker-record');
        const pulled = join(home, 'pulled');
        const bin = await fakeDocker(
            home,
            record,
            `if [ "$1" = "info" ]; then printf 'linux\\n'; exit 0; fi
if [ "$1" = "pull" ]; then : > "${pulled}"; exit 0; fi
case "$*" in *dev.workbenches.studio.contract*) printf '1\\n'; exit 0;; esac
if [ "$1" = "image" ]; then [ -f "${pulled}" ] || exit 1; printf '%s\\n' ${imageId}; exit 0; fi
if [ "$1" = "network" ] && [ "$2" = "inspect" ]; then exit 1; fi
if [ "$1" = "network" ]; then exit 0; fi
if [ "$1" = "run" ]; then printf '%s\\n' studio-container; exit 0; fi
if [ "$1" = "inspect" ]; then printf 'true ${imageId}\\n'; exit 0; fi
if [ "$1" = "rm" ]; then exit 0; fi
exit 1`
        );
        const path = `${bin}:${process.env.PATH ?? ''}`;
        const options = await startOptions(DEFAULT_STUDIO_IMAGE);
        const started = await cli(
            home,
            [
                'studio',
                '--no-open',
                '--json',
                '--port',
                String(options.uiPort),
                '--api-port',
                String(options.apiPort),
            ],
            path
        );
        expect(started.code).toBe(0);
        const { open_url: _link, ...status } = JSON.parse(started.stdout);
        expect(status).toEqual({
            running: true,
            url: `http://127.0.0.1:${options.uiPort}`,
            image: DEFAULT_STUDIO_IMAGE,
            image_id: imageId,
        });
        expect((await cli(home, ['studio', 'stop'], path)).code).toBe(0);
        const lines = (await readFile(record, 'utf8')).trim().split('\n');
        expect(lines.slice(0, 5)).toEqual([
            'info --format {{.OSType}}',
            `image inspect --format {{.Id}} ${DEFAULT_STUDIO_IMAGE}`,
            `pull ${DEFAULT_STUDIO_IMAGE}`,
            `image inspect --format {{.Id}} ${DEFAULT_STUDIO_IMAGE}`,
            `image inspect --format {{index .Config.Labels "dev.workbenches.studio.contract"}} ${imageId}`,
        ]);
        const run = lines.find((line) => line.startsWith('run ')) ?? '';
        expect(run).toEndWith(` ${imageId}`);
    });

    test('refuses an image that does not implement the Studio contract', async () => {
        for (const label of ['2', '']) {
            const home = await temporaryHome();
            const record = join(home, 'docker-record');
            const bin = await fakeDocker(
                home,
                record,
                `if [ "$1" = "info" ]; then printf 'linux\\n'; exit 0; fi
case "$*" in *dev.workbenches.studio.contract*) printf '${label}\\n'; exit 0;; esac
if [ "$1" = "image" ]; then printf '%s\\n' ${imageId}; exit 0; fi
exit 1`
            );
            const previous = process.env.PATH;
            process.env.PATH = `${bin}:${previous ?? ''}`;
            try {
                const lifecycle = studioLifecycle(home, 'linux');
                await expect(
                    lifecycle.start(await startOptions('other-studio:test'))
                ).rejects.toThrow(
                    `Studio image other-studio:test implements Studio contract ${label || 'none'}, but this version of wb requires contract 1.`
                );
                expect(lifecycle.status()).toMatchObject({ running: false });
            } finally {
                process.env.PATH = previous;
            }
            const lines = (await readFile(record, 'utf8')).trim().split('\n');
            expect(lines.some((line) => line.startsWith('run '))).toBeFalse();
            expect(open(home).studioState.read()).toBeUndefined();
            expect(
                await stat(join(home, 'studio.sock')).catch(() => undefined)
            ).toBeUndefined();
        }
    });

    test('explains a stopped Docker daemon and Windows containers', async () => {
        const cases = [
            [
                'echo "Cannot connect to the Docker daemon at unix:///var/run/docker.sock" >&2; exit 1',
                "Docker isn't running. Start Docker and run wb studio again.",
            ],
            [
                "printf 'windows\\n'; exit 0",
                'Docker is using Windows containers. Switch Docker Desktop to Linux containers and run wb studio again.',
            ],
        ] as const;
        for (const [info, message] of cases) {
            const home = await temporaryHome();
            const record = join(home, 'docker-record');
            const bin = await fakeDocker(
                home,
                record,
                `if [ "$1" = "info" ]; then ${info}; fi
exit 1`
            );
            const options = await startOptions();
            const result = await cli(
                home,
                [
                    'studio',
                    '--no-open',
                    '--port',
                    String(options.uiPort),
                    '--api-port',
                    String(options.apiPort),
                ],
                `${bin}:${process.env.PATH ?? ''}`,
                { WB_DOCKER_RECORD: record }
            );
            expect(result.code).toBe(1);
            expect(result.stderr).toContain(message);
            expect(result.stderr).not.toContain('Cannot connect');
            expect((await readFile(record, 'utf8')).trim().split('\n')).toEqual([
                'info --format {{.OSType}}',
            ]);
            expect(open(home).studioState.read()).toBeUndefined();
        }
    });
});

/** A fake `docker` that records each invocation and then runs `script`. */
async function fakeDocker(home: string, record: string, script: string) {
    const bin = join(home, 'bin');
    await mkdir(bin, { recursive: true });
    const docker = join(bin, 'docker');
    await writeFile(
        docker,
        `#!/bin/sh\nprintf '%s\\n' "$*" >> "${record}"\n${script}\n`
    );
    await chmod(docker, 0o755);
    return bin;
}

async function seedSession(home: string, project?: string) {
    const runs = open(home).runs;
    const sessions = open(home).sessions;
    const id = RunStore.createId();
    const storedProject = project
        ? await open(home).projects.create(project)
        : undefined;
    const session = await sessions.create({
        id,
        ...(storedProject ? { project: storedProject } : {}),
        workbench: 'fixture',
        workbench_version: '1.0.0',
        runner: 'opencode',
        model: 'openai/test',
        runtime: 'local',
        reference: 'fixture',
        workbench_path: '/fixture',
        workspace: '/workspace',
        workspaces: [],
        latest_run_id: id,
    });
    const run = await runs.create({
        id,
        metadata: {
            workbench: session.workbench,
            workbench_version: session.workbench_version,
            runner: session.runner,
            model: session.model,
            runtime: session.runtime,
            workspace: session.workspace,
            session_id: session.id,
            task: '# Inspect the project\nDetails',
        },
        request: {
            workbench_path: session.workbench_path,
            workspace: session.workspace,
            task: '# Inspect the project\nDetails',
        },
    });
    await runs.appendEvent(run.id, {
        protocol: 0,
        run_id: run.id,
        sequence: 1,
        timestamp: new Date().toISOString(),
        type: 'run.started',
        runner: run.runner,
        data: {},
    });
    return { sessionId: session.id, runId: run.id };
}

async function cli(
    home: string,
    args: string[],
    path?: string,
    environment: Record<string, string> = {}
) {
    const child = Bun.spawn([process.execPath, 'src/cli.ts', ...args], {
        cwd: process.cwd(),
        env: { WORKBENCH_HOME: home, PATH: path ?? '', ...environment },
        stdout: 'pipe',
        stderr: 'pipe',
    });
    const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
    ]);
    return { code, stdout, stderr };
}

async function request(
    server: StudioServer,
    path: string,
    token = 'test-token',
    host = `127.0.0.1:${server.port}`
): Promise<Response> {
    return fetch(`http://127.0.0.1:${server.port}${path}`, {
        headers: {
            Host: host,
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
    });
}

function webSocket(server: StudioServer, path: string): WebSocket {
    return new WebSocket(`ws://127.0.0.1:${server.port}${path}`, {
        headers: { Authorization: 'Bearer test-token' },
    });
}

function nextFrame(socket: WebSocket): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(
            () => reject(new Error('WebSocket frame timed out')),
            5_000
        );
        socket.addEventListener(
            'message',
            (event) => {
                clearTimeout(timer);
                const value: unknown = JSON.parse(String(event.data));
                if (!isRecord(value)) {
                    reject(new Error('WebSocket frame was not an object'));
                    return;
                }
                resolve(value);
            },
            { once: true }
        );
        socket.addEventListener(
            'error',
            () => {
                clearTimeout(timer);
                reject(new Error('WebSocket failed'));
            },
            { once: true }
        );
    });
}

// Mirrors the container's check, written from the shared open code format.
function verifyOpenCode(token: string, code: string): boolean {
    const match = code.match(OPEN_CODE);
    if (!match) return false;
    const openKey = createHmac('sha256', new TextEncoder().encode(token))
        .update('wb studio open v1')
        .digest();
    const expected = createHmac('sha256', openKey)
        .update(`v1.${match[1]}.${match[2]}`)
        .digest();
    const actual = Buffer.from(match[3] as string, 'base64url');
    return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function temporaryHome(): Promise<string> {
    const home = await mkdtemp(join(tmpdir(), 'workbench-studio-test-'));
    homes.push(home);
    return home;
}

async function unusedPort(): Promise<number> {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing port');
    await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
    );
    return address.port;
}
