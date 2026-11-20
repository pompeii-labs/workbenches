import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CloudClient } from '../src/cloud/client.js';
import { RegistryClient } from '../src/registry/client.js';
import { RegistryCredentialFile } from '../src/registry/credentials.js';
import { RegistryKeyring } from '../src/registry/keyring.js';
import { seedModelCatalogFixture } from './model-catalog-fixture.js';

const id = 'wb_abcdefghijklmnopqrstuvwx';
const session = 'wbs_abcdefghijklmnopqrstuvwx';
const command = 'wbc_abcdefghijklmnopqrstuvwx';
const requests: { method: string; path: string; body: unknown }[] = [];
let home: string;
let server: Bun.Server<undefined>;
let status = 'completed';
let events: Record<string, unknown>[] = [];
let failure = false;
let sockets = 0;
let reconnect = false;
let silent = false;
let unsafeFile = false;
let finishAfterReplay = false;

function event(type: string, data: unknown = {}) {
    return {
        protocol: 0,
        run_id: id,
        sequence: events.length + 1,
        timestamp: '2026-11-19T00:00:00.000Z',
        type,
        runner: 'opencode',
        data,
    };
}

function run() {
    return {
        id,
        session_id: session,
        status,
        workbench: { slug: 'expert', organization_slug: 'example' },
        version: { version: '1.0.0' },
        final_response: 'Cloud answer',
        // The API reports a successful run's terminal reason as "completed".
        terminal_reason: status === 'completed' ? 'completed' : null,
        created_at: '2026-11-19T00:00:00.000Z',
    };
}

beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'workbench-cloud-'));
    await seedModelCatalogFixture(home);
    status = 'completed';
    failure = false;
    sockets = 0;
    reconnect = false;
    silent = false;
    unsafeFile = false;
    finishAfterReplay = false;
    requests.length = 0;
    events = [];
    events.push(event('run.started', { workbench: 'expert' }));
    events.push(event('output.text', { id: 'answer', text: 'Cloud answer' }));
    events.push(event('run.completed'));
    server = Bun.serve({
        port: 0,
        hostname: '127.0.0.1',
        async fetch(request, server) {
            const url = new URL(request.url);
            expect(request.headers.get('authorization')).toBe(
                'Bearer obvious-fake-cloud-key'
            );
            requests.push({
                method: request.method,
                path: url.pathname + url.search,
                body: request.method === 'POST' ? await request.json() : undefined,
            });
            if (failure)
                return Response.json(
                    {
                        error: {
                            code: 'worker_offline',
                            message: 'The worker is not connected.',
                        },
                    },
                    { status: 409 }
                );
            if (url.pathname === '/v1/resolutions')
                return Response.json({
                    workbench_id: 'fake-workbench',
                    latest_version: { id: 'fake-latest-version', version: '2.0.0' },
                });
            if (url.pathname === '/v1/workbenches/fake-workbench/versions')
                return Response.json({
                    versions: [
                        {
                            id: 'fake-pinned-version',
                            version: '1.0.0',
                            prerelease: false,
                            withdrawn: false,
                        },
                    ],
                });
            if (url.pathname.endsWith('/events')) {
                if (request.headers.get('upgrade') === 'websocket') {
                    sockets++;
                    if (server.upgrade(request, { data: undefined })) return;
                }
                const after = Number(url.searchParams.get('after') ?? 0);
                const page = events
                    .filter((entry) => Number(entry.sequence) > after)
                    .slice(0, Number(url.searchParams.get('limit') ?? 100));
                if (finishAfterReplay) {
                    finishAfterReplay = false;
                    events.push(event('output.text', { text: 'Cloud answer' }));
                    events.push(event('run.completed'));
                    status = 'completed';
                }
                return Response.json({
                    events: page,
                    next: page.at(-1)?.sequence ?? after,
                });
            }
            if (url.pathname.endsWith('/commands'))
                return Response.json(
                    {
                        command: { id: command, run_id: id, status: 'pending' },
                        after_sequence: 3,
                    },
                    { status: 202 }
                );
            if (url.pathname.endsWith('/outcome/files'))
                return Response.json({
                    files: [
                        {
                            path: unsafeFile ? '../outside.txt' : 'reports/result.txt',
                            name: 'Result',
                            media_type: 'text/plain',
                            size: 5,
                            // The API sends null for a file without a description.
                            description: null,
                            url: `${server.url}v1/runs/${id}/outcome/files/reports/result.txt`,
                        },
                    ],
                    archive_url: `${server.url}v1/runs/${id}/outcome`,
                });
            if (url.pathname.endsWith('/result.txt')) return new Response('bytes');
            if (url.pathname.endsWith('/changes'))
                return new Response('diff --git a/file b/file\n');
            if (url.pathname === '/v1/runs' && request.method === 'GET') {
                // The API filters by view, as documented: active excludes needs_input.
                const view = url.searchParams.get('view');
                const listed =
                    view === 'all' ||
                    (view === 'needs_input'
                        ? status === 'needs_input'
                        : view === 'active' &&
                          !['needs_input', 'completed', 'failed', 'cancelled'].includes(
                              status
                          ));
                return Response.json({ runs: listed ? [run()] : [], next: null });
            }
            return Response.json(run(), {
                status: request.method === 'POST' ? 201 : 200,
            });
        },
        websocket: {
            open(socket) {
                if (reconnect && sockets === 1) {
                    for (const entry of events.slice(0, 2))
                        socket.send(JSON.stringify(entry));
                    socket.close(4001, 'reauthenticate');
                    return;
                }
                if (silent && sockets === 1) {
                    // A dead idle connection: no more frames and no close.
                    for (const entry of events.slice(0, 2))
                        socket.send(JSON.stringify(entry));
                    return;
                }
                if (reconnect || silent) status = 'completed';
                for (const entry of events) socket.send(JSON.stringify(entry));
                if (
                    status === 'completed' ||
                    status === 'failed' ||
                    status === 'cancelled'
                )
                    socket.close(1000);
            },
            message() {},
        },
    });
    await new RegistryCredentialFile(home).write([
        {
            url: server.url.toString().replace(/\/$/, ''),
            defaultSlug: 'example',
            organizations: [
                {
                    organizationId: 'fake-organization',
                    slug: 'example',
                    name: 'Example',
                    personal: false,
                    token: 'obvious-fake-cloud-key',
                    keyId: 'fake-key',
                    scopes: ['runs:read', 'runs:write'],
                    expiresAt: '2099-01-01T00:00:00Z',
                },
            ],
        },
    ]);
});

afterEach(async () => {
    server.stop(true);
    await rm(home, { recursive: true, force: true });
});

async function cli(args: string[], input = '') {
    const child = Bun.spawn(
        [
            process.execPath,
            resolve('src/cli.ts'),
            ...args,
            '--api-url',
            server.url.toString(),
        ],
        {
            env: {
                HOME: home,
                WORKBENCH_HOME: home,
                PATH: process.env.PATH ?? '',
                NO_COLOR: '1',
                FORCE_COLOR: '0',
            },
            stdout: 'pipe',
            stderr: 'pipe',
            stdin: 'pipe',
        }
    );
    child.stdin.write(input);
    child.stdin.end();
    const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
    ]);
    return { stdout, stderr, code };
}

describe('cloud commands', () => {
    test('starts a detached run with documented API fields and a local-shaped receipt', async () => {
        const result = await cli([
            'run',
            '--cloud',
            'example/expert',
            '--task',
            'Review',
            '--repo',
            'example/api',
            '--ref',
            'main',
            '--worker',
            'laptop',
            '--project',
            'API',
            '--max-minutes',
            '20',
            '--detach',
            '--json',
        ]);
        expect(result.code).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
            run_id: id,
            session_id: session,
            input_id: expect.any(String),
            after_sequence: 0,
        });
        expect(requests[0]).toMatchObject({
            method: 'POST',
            path: '/v1/runs',
            body: {
                workbench: 'example/expert',
                task: 'Review',
                workspace: { repository: 'example/api', ref: 'main' },
                worker: 'laptop',
                project: 'API',
                max_minutes: 20,
                idempotency_key: expect.any(String),
            },
        });
    });

    for (const action of ['run', 'attach'])
        for (const mode of ['', '--json', '--final']) {
            test(`${action} follows normalized events in ${mode || 'human'} mode`, async () => {
                const result = await cli(
                    action === 'run'
                        ? [
                              'run',
                              '--cloud',
                              'example/expert',
                              '--task',
                              'Review',
                              ...(mode ? [mode] : []),
                          ]
                        : ['attach', '--cloud', id, ...(mode ? [mode] : [])]
                );
                expect(result.code).toBe(0);
                if (mode === '--json')
                    expect(
                        result.stdout
                            .trim()
                            .split('\n')
                            .map((line) => JSON.parse(line))
                    ).toEqual(events);
                else if (mode === '--final')
                    expect(result.stdout).toBe('Cloud answer\n');
                else expect(result.stdout).toContain('Completed');
                expect(sockets).toBeGreaterThan(0);
            });
        }

    for (const [state, type, code] of [
        ['completed', 'run.completed', 0],
        ['failed', 'run.failed', 1],
        ['cancelled', 'run.cancelled', 130],
        ['needs_input', 'input.requested', 2],
        ['running', 'run.started', 124],
    ] as const) {
        test(`wait returns ${state} with exit ${code}`, async () => {
            status = state;
            events = [];
            events.push(
                event(
                    type,
                    type === 'input.requested'
                        ? { id: 'permission', options: ['allow_once', 'reject'] }
                        : {}
                )
            );
            const result = await cli([
                'wait',
                '--cloud',
                id,
                '--json',
                '--timeout',
                '0.05',
            ]);
            expect(result.code).toBe(code);
            expect(JSON.parse(result.stdout)).toMatchObject({
                run_id: id,
                session_id: session,
                sequence: 1,
                state: state === 'running' ? 'timeout' : state,
                pending_requests: expect.any(Array),
                usage: expect.any(Object),
                usage_total: expect.any(Object),
                final: expect.any(String),
            });
        });
    }

    test('wait preserves turn and usage boundaries after a cursor', async () => {
        status = 'running';
        events = [];
        events.push(event('turn.started'));
        events.push(event('output.text', { text: 'First' }));
        events.push(event('usage.updated', { kind: 'delta', input_tokens: 10 }));
        events.push(event('turn.completed'));
        events.push(event('turn.started'));
        events.push(event('output.text', { text: 'Second' }));
        events.push(event('usage.updated', { kind: 'delta', input_tokens: 20 }));
        events.push(event('turn.completed'));
        const result = await cli(['wait', '--cloud', id, '--after', '4', '--json']);
        expect(JSON.parse(result.stdout)).toMatchObject({
            state: 'turn_completed',
            sequence: 8,
            final: 'Second',
            usage: { kind: 'delta', input_tokens: 20 },
            usage_total: { kind: 'total', input_tokens: 30 },
        });
    });

    for (const action of ['send', 'answer'])
        for (const json of [false, true]) {
            test(`${action} submits a command and prints ${json ? 'JSON' : 'human'} receipt`, async () => {
                const result = await cli([
                    action,
                    '--cloud',
                    id,
                    ...(action === 'answer' ? ['permission', 'allow'] : ['Next']),
                    ...(json ? ['--json'] : []),
                ]);
                expect(result.code).toBe(0);
                expect(
                    requests.find((request) => request.path.endsWith('/commands'))
                ).toMatchObject({
                    method: 'POST',
                    body: {
                        kind: action,
                        payload:
                            action === 'answer'
                                ? { request_id: 'permission', response: 'allow' }
                                : { text: 'Next' },
                        idempotency_key: expect.any(String),
                    },
                });
                if (json)
                    expect(JSON.parse(result.stdout)).toMatchObject({
                        session_id: session,
                        run_id: id,
                        input_id: command,
                        after_sequence: 3,
                    });
                else expect(result.stdout).toContain(command);
            });
        }

    test('kill cancels through the commands endpoint', async () => {
        expect((await cli(['kill', '--cloud', id])).code).toBe(0);
        expect(
            requests.find((request) => request.path.endsWith('/commands'))
        ).toMatchObject({ method: 'POST', body: { kind: 'cancel', payload: {} } });
    });

    for (const json of [false, true])
        test(`ps lists organization runs in ${json ? 'JSON' : 'human'} mode`, async () => {
            const result = await cli([
                'ps',
                '--cloud',
                '--all',
                ...(json ? ['--json'] : []),
            ]);
            expect(result.code).toBe(0);
            expect(result.stdout).toContain(id);
            expect(requests[0]?.path).toContain('/v1/runs?');
            if (json)
                expect(JSON.parse(result.stdout)).toMatchObject({
                    id,
                    session_id: session,
                    needs_input: false,
                });
        });

    test('outcome lists files, downloads original bytes, and prints a diff', async () => {
        const listed = await cli(['outcome', '--cloud', id, '--json']);
        expect(listed.code).toBe(0);
        expect(JSON.parse(listed.stdout).files[0].path).toBe('reports/result.txt');
        const destination = join(home, 'download');
        expect(
            (await cli(['outcome', '--cloud', id, '--export', destination])).code
        ).toBe(0);
        expect(await readFile(join(destination, 'reports/result.txt'), 'utf8')).toBe(
            'bytes'
        );
        expect((await cli(['outcome', '--cloud', id, '--diff'])).stdout).toBe(
            'diff --git a/file b/file\n'
        );
    });

    test('passes the API error message through unchanged', async () => {
        failure = true;
        const result = await cli([
            'run',
            '--cloud',
            'example/expert',
            '--task',
            'Review',
            '--detach',
        ]);
        expect(result.code).toBe(1);
        expect(result.stderr).toBe('error: The worker is not connected.\n');
    });

    for (const extra of [
        ['--dir', '.'],
        ['--workspace', 'api=.'],
    ])
        test(`refuses ${extra[0]} before HTTP`, async () => {
            const result = await cli([
                'run',
                '--cloud',
                'example/expert',
                '--task',
                'Review',
                ...extra,
            ]);
            expect(result.code).toBe(1);
            expect(result.stderr).toContain(`${extra[0]} cannot be used with --cloud`);
            expect(requests).toHaveLength(0);
        });

    for (const reference of ['./expert', 'saved-expert'])
        test(`refuses unpublished reference ${reference}`, async () => {
            const result = await cli(['run', '--cloud', reference, '--task', 'Review']);
            expect(result.code).toBe(1);
            expect(result.stderr).toContain('push the Workbench first');
            expect(requests).toHaveLength(0);
        });

    test('refuses cloud question rejection, which the API has no command for', async () => {
        const result = await cli(['answer', '--cloud', id, 'question', '--reject']);
        expect(result.code).toBe(1);
        expect(result.stderr).toContain('--reject is not available for cloud runs yet');
        expect(requests).toHaveLength(0);
    });

    test('resolves an exact stored version before starting the run', async () => {
        const result = await cli([
            'run',
            '--cloud',
            'example/expert@1.0.0',
            '--task',
            'Review',
            '--detach',
            '--json',
        ]);
        expect(result.code).toBe(0);
        expect(requests.map((request) => request.path)).toEqual([
            '/v1/resolutions',
            '/v1/workbenches/fake-workbench/versions',
            '/v1/runs',
        ]);
        expect(requests.at(-1)?.body).toMatchObject({
            workbench: { version_id: 'fake-pinned-version' },
        });
    });

    test('reconnects with its last sequence after WebSocket reauthentication', async () => {
        reconnect = true;
        status = 'running';
        const result = await cli(['attach', '--cloud', id, '--json']);
        expect(result.code).toBe(0);
        expect(
            result.stdout
                .trim()
                .split('\n')
                .map((line) => JSON.parse(line))
        ).toEqual(events);
        expect(
            requests.filter((request) => request.path.includes('/events'))
        ).toHaveLength(2);
        expect(
            requests.filter((request) => request.path.includes('/events'))[1]?.path
        ).toEndWith('after=2');
    });

    test('replaces a silent WebSocket and resumes from its last sequence', async () => {
        silent = true;
        status = 'running';
        const url = server.url.toString().replace(/\/$/, '');
        const client = new CloudClient(
            new RegistryClient({ apiUrl: url }),
            new RegistryKeyring(home, url),
            // Long enough that a loaded machine still delivers the first frames in time.
            1_000
        );
        const followed = [];
        for await (const entry of client.follow(id)) followed.push(entry);
        expect(followed.map((entry) => entry.sequence)).toEqual([1, 2, 3]);
        expect(sockets).toBe(2);
        expect(
            requests.filter((request) => request.path.includes('/events'))[1]?.path
        ).toEndWith('after=2');
    });

    test('preserves cloud-only normalized event types in JSON without relabelling', async () => {
        events = [];
        events.push(event('image.building', { build_id: 'fake-build' }));
        events.push(event('sandbox.preparing', { image: 'example/image:1' }));
        events.push(event('output.text', { text: 'Cloud answer' }));
        events.push(event('run.completed'));
        const result = await cli(['attach', '--cloud', id, '--json']);
        expect(
            result.stdout
                .trim()
                .split('\n')
                .map((line) => JSON.parse(line))
        ).toEqual(events);
        expect((await cli(['attach', '--cloud', id, '--final'])).stdout).toBe(
            'Cloud answer\n'
        );
    });

    test('wait drains event pages and reports zero usage at an already consumed terminal cursor', async () => {
        events = [];
        for (let index = 0; index < 501; index++)
            events.push(event('usage.updated', { kind: 'delta', input_tokens: 1 }));
        events.push(event('run.completed'));
        const result = await cli(['wait', '--cloud', id, '--after', '502', '--json']);
        expect(result.code).toBe(0);
        const settled = JSON.parse(result.stdout);
        expect(settled).toMatchObject({
            state: 'completed',
            sequence: 502,
            usage: { kind: 'delta', input_tokens: 0 },
            usage_total: { kind: 'total', input_tokens: 501 },
        });
        expect(settled).not.toHaveProperty('error');
        expect(
            requests.some((request) => request.path.includes('after=500'))
        ).toBeTrue();
    });

    test('wait retains the earliest completed turn when later turns already ended', async () => {
        events = [];
        events.push(event('turn.started'));
        events.push(event('output.text', { text: 'First' }));
        events.push(event('turn.completed'));
        events.push(event('turn.started'));
        events.push(event('output.text', { text: 'Second' }));
        events.push(event('turn.completed'));
        events.push(event('run.completed'));
        const result = await cli(['wait', '--cloud', id, '--json']);
        expect(JSON.parse(result.stdout)).toMatchObject({
            state: 'turn_completed',
            sequence: 3,
            final: 'First',
        });
    });

    for (const flag of ['--steer', '--queue'])
        test(`send maps ${flag} without changing delivery modes`, async () => {
            const result = await cli(['send', '--cloud', id, 'Next', flag, '--json']);
            expect(result.code).toBe(0);
            expect(requests.at(-1)?.body).toMatchObject({
                kind: flag.slice(2),
                payload: { text: 'Next' },
            });
            expect(JSON.parse(result.stdout)).toMatchObject({
                command_status: 'pending',
            });
        });

    test('answer returns once the runner takes it, with a cursor past the answer', async () => {
        status = 'running';
        events = [];
        events.push(event('run.started'));
        events.push(event('turn.started'));
        events.push(event('question.requested', { id: 'question' }));
        events.push(event('question.answered', { id: 'question' }));
        events.push(event('output.text', { text: 'Blue' }));
        const result = await cli([
            'answer',
            '--cloud',
            id,
            'question',
            'Blue',
            '--json',
        ]);
        expect(result.code).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
            input_id: command,
            after_sequence: 4,
            command_status: 'delivered',
        });
    });

    test('answer preserves question arrays and API error codes', async () => {
        expect(
            (
                await cli([
                    'answer',
                    '--cloud',
                    id,
                    'question',
                    '[["First"],["Second"]]',
                    '--json',
                ])
            ).code
        ).toBe(0);
        expect(
            requests.find((request) => request.path.endsWith('/commands'))?.body
        ).toMatchObject({
            payload: { request_id: 'question', response: [['First'], ['Second']] },
        });
        failure = true;
        const result = await cli(['send', '--cloud', id, 'Next', '--json']);
        expect(result.code).toBe(1);
        expect(JSON.parse(result.stdout)).toEqual({
            error: {
                code: 'worker_offline',
                message: 'The worker is not connected.',
            },
        });
    });

    test('ps asks the API for unfinished runs only and reads no events for a running one', async () => {
        status = 'running';
        const result = await cli(['ps', '--cloud', '--json']);
        expect(result.code).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({ id, needs_input: false });
        expect(
            requests.map((request) => new URL(request.path, 'https://api.example.test'))
        ).toEqual([
            expect.objectContaining({ pathname: '/v1/runs' }),
            expect.objectContaining({ pathname: '/v1/runs' }),
        ]);
        expect(
            requests.map((request) =>
                new URL(request.path, 'https://api.example.test').searchParams.get(
                    'view'
                )
            )
        ).toEqual(['needs_input', 'active']);
    });

    test('ps includes pending input even after an earlier turn boundary', async () => {
        status = 'needs_input';
        events = [];
        events.push(event('turn.completed'));
        events.push(event('turn.started'));
        events.push(event('question.requested', { id: 'question', questions: [] }));
        const result = await cli(['ps', '--cloud', '--json']);
        expect(result.code).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
            needs_input: true,
            state: 'needs_input',
            pending_requests: [{ id: 'question', kind: 'question', sequence: 3 }],
        });
    });

    test('outcome refuses traversal and existing destinations before overwriting files', async () => {
        unsafeFile = true;
        const destination = join(home, 'download');
        const result = await cli(['outcome', '--cloud', id, '--export', destination]);
        expect(result.code).toBe(1);
        expect(result.stderr).toContain('unsafe file path');
        unsafeFile = false;
        expect((await cli(['outcome', '--cloud', id, '--export', home])).code).toBe(1);
        expect(
            requests.some((request) => request.path.endsWith('/result.txt'))
        ).toBeFalse();
    });

    test('a run without --cloud still resolves a saved local alias', async () => {
        await seedModelCatalogFixture(home);
        const result = await cli(['run', 'unsaved-expert', '--task', 'Review']);
        expect(result.code).toBe(1);
        expect(result.stderr).toContain('Workbench is not saved');
        expect(requests).toHaveLength(0);
    });

    test('reads cloud tasks and answers through the existing file and stdin flags', async () => {
        const file = join(home, 'task.txt');
        await writeFile(file, 'Task from file');
        expect(
            (
                await cli([
                    'run',
                    '--cloud',
                    'example/expert',
                    '--task-file',
                    file,
                    '--detach',
                ])
            ).code
        ).toBe(0);
        expect(requests.at(-1)?.body).toMatchObject({ task: 'Task from file' });
        expect(
            (
                await cli(
                    ['send', '--cloud', id, '--stdin', '--json'],
                    'Input from stdin'
                )
            ).code
        ).toBe(0);
        expect(requests.at(-1)?.body).toMatchObject({
            payload: { text: 'Input from stdin' },
        });
        await writeFile(file, '[["First"]]');
        expect(
            (
                await cli([
                    'answer',
                    '--cloud',
                    id,
                    'question',
                    '--response-file',
                    file,
                    '--json',
                ])
            ).code
        ).toBe(0);
        expect(
            requests.findLast((request) => request.path.endsWith('/commands'))?.body
        ).toMatchObject({
            payload: { request_id: 'question', response: [['First']] },
        });
    });

    test('wait human output reports the terminal response and trusts the event over stale run status', async () => {
        status = 'running';
        const result = await cli(['wait', '--cloud', id]);
        expect(result.code).toBe(0);
        expect(result.stdout).toBe(
            `completed · ${session} · sequence 3\nCloud answer\n`
        );
    });

    test('wait drains the durable tail when completion races its initial replay', async () => {
        status = 'running';
        events = [];
        events.push(event('run.started'));
        finishAfterReplay = true;
        const result = await cli(['wait', '--cloud', id, '--json']);
        expect(result.code).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
            state: 'completed',
            sequence: 3,
            final: 'Cloud answer',
        });
    });
});
