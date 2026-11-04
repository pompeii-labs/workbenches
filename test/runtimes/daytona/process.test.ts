import { afterEach, describe, expect, test } from 'bun:test';

import { json } from './http.js';
import {
    encode,
    framed,
    type LogSocket,
    logToolbox,
    sessionOf,
    stopLogServers,
} from './logs.js';

afterEach(stopLogServers);

/** The toolbox's reply to input for a command that exited and took its input pipe with it. */
const inputPipeGone = () =>
    new Response(
        'failed to open input pipe: open /tmp/session/cmd-1/input.pipe: no such file or directory',
        { status: 500 }
    );

describe('SessionProcess', () => {
    test('streams standard output and standard error in order and resolves after the last of it', async () => {
        let exited = false;
        const fake = logToolbox(
            (_index, socket) => {
                socket.send(framed('stdout', 'one '));
                socket.send(framed('stderr', 'warn 1\n'));
                socket.send(framed('stdout', 'two'));
                socket.send(framed('stderr', 'warn 2\n'));
                exited = true;
                socket.close();
            },
            { exited: () => exited }
        );
        const sandbox = await fake.sandbox();
        const events: string[] = [];
        const process = await sandbox.start('opencode serve', {
            cwd: '/workspace',
            env: { TOKEN: "it's" },
            // A slow receiver still gets everything before the command is reported done.
            onStdout: async (data) => {
                await Bun.sleep(5);
                events.push(`out:${data}`);
            },
            onStderr: (data) => void events.push(`err:${data}`),
        });
        const result = await process.wait();
        events.push(`exit:${result.code}`);
        expect(events.filter((event) => event.startsWith('out:'))).toEqual([
            'out:one ',
            'out:two',
        ]);
        expect(events.filter((event) => event.startsWith('err:'))).toEqual([
            'err:warn 1\n',
            'err:warn 2\n',
        ]);
        expect(events.at(-1)).toBe('exit:0');
        // Received output is not kept a second time for the result.
        expect(result).toEqual({ code: 0, stdout: '', stderr: '' });
        expect(fake.connections()).toBe(1);
        expect(fake.upgrades[0]).toEqual({
            path: `/toolbox/sandbox-1/process/session/${sessionOf(fake.requests)}/command/cmd-1/logs?follow=true`,
            authorization: 'Bearer secret-api-key',
        });
        const exec = fake.requests.find((request) =>
            request.url.pathname.endsWith('/exec')
        );
        const body = JSON.parse(String(exec?.body));
        expect(body.runAsync).toBe(true);
        expect(body.command).toMatch(
            /^\(\. '\/tmp\/\.workbench-env-[0-9a-f-]{36}' && rm -f '\/tmp\/\.workbench-env-[0-9a-f-]{36}' && cd '\/workspace' && opencode serve\) 2>'\/tmp\/\.workbench-stderr-[0-9a-f-]{36}'$/
        );
        expect(body.command).not.toContain('TOKEN');
        // Nothing reads the whole log over HTTP.
        expect(
            fake.requests.filter((request) => request.url.pathname.endsWith('/logs'))
        ).toEqual([]);
        // The session is removed once the command ends.
        expect(fake.requests.at(-1)?.method).toBe('DELETE');
    });

    test('a connection dropped mid-output is reopened with no repeated or missing bytes', async () => {
        let exited = false;
        // A two-byte character the first connection splits.
        const accent = encode('é');
        const fake = logToolbox(
            (index, socket) => {
                if (index === 0) {
                    socket.send(framed('stdout', 'abc'));
                    socket.send(framed('stderr', 'x'));
                    socket.send(
                        framed(
                            'stdout',
                            new Uint8Array([...encode('d'), accent[0] ?? 0])
                        )
                    );
                    socket.terminate();
                    return;
                }
                // Every connection replays the output from its start.
                socket.send(framed('stdout', 'abc'));
                socket.send(framed('stderr', 'x'));
                socket.send(
                    framed('stdout', new Uint8Array([...encode('d'), ...accent]))
                );
                socket.send(framed('stderr', 'yz'));
                socket.send(framed('stdout', 'f'));
                exited = true;
                socket.close();
            },
            { exited: () => exited }
        );
        const sandbox = await fake.sandbox();
        const out: string[] = [];
        const err: string[] = [];
        const process = await sandbox.start('job', {
            onStdout: (data) => void out.push(data),
            onStderr: (data) => void err.push(data),
        });
        expect((await process.wait()).code).toBe(0);
        expect(out.join('')).toBe('abcdéf');
        expect(err.join('')).toBe('xyz');
        expect(fake.connections()).toBe(2);
    });

    test('a connection dropped as the command exits is followed by one that fills the rest', async () => {
        let exited = false;
        const fake = logToolbox(
            (index, socket) => {
                socket.send(framed('stdout', 'first\n'));
                if (index === 0) {
                    exited = true;
                    socket.terminate();
                    return;
                }
                socket.send(framed('stdout', 'last\n'));
                socket.close();
            },
            { exited: () => exited }
        );
        const sandbox = await fake.sandbox();
        const out: string[] = [];
        const process = await sandbox.start('job', {
            onStdout: (data) => void out.push(data),
        });
        expect((await process.wait()).code).toBe(0);
        expect(out).toEqual(['first\n', 'last\n']);
        expect(fake.connections()).toBe(2);
    });

    test('keeps a stream nobody receives so the result can return it', async () => {
        const fake = logToolbox(
            (_index, socket) => {
                socket.send(framed('stdout', 'done'));
                socket.send(framed('stderr', 'note'));
                socket.close();
            },
            { status: () => json({ id: 'cmd-1', exitCode: 3 }) }
        );
        const sandbox = await fake.sandbox();
        const process = await sandbox.start('job', {});
        expect(await process.wait()).toEqual({
            code: 3,
            stdout: 'done',
            stderr: 'note',
        });
    });

    test('sends input to a background command and kills it by ending its session', async () => {
        const fake = logToolbox((_index, socket) => {
            socket.send(framed('stdout', 'ready\n'));
        });
        const sandbox = await fake.sandbox();
        const process = await sandbox.start('cat', { stdin: true });
        await process.sendStdin('hello\n');
        const input = fake.requests.find((request) =>
            request.url.pathname.endsWith('/input')
        );
        expect(JSON.parse(String(input?.body))).toEqual({ data: 'hello\n' });
        await process.kill();
        expect((await process.wait()).code).toBe(143);
        expect(
            fake.requests.filter((request) => request.method === 'DELETE')
        ).toHaveLength(1);
    });

    test('a write to a command that has exited leaves the exit and its standard error to wait', async () => {
        const { promise: opened, resolve: connected } =
            Promise.withResolvers<LogSocket>();
        let statuses = 0;
        const fake = logToolbox(
            // The log stream stays open, so the follower has not seen the exit.
            (_index, socket) => connected(socket),
            {
                status: () => {
                    statuses++;
                    return json({ id: 'cmd-1', exitCode: 1 });
                },
                input: () => inputPipeGone(),
                execute: (request) =>
                    json({
                        exitCode: 0,
                        result: String(
                            JSON.parse(String(request.body)).command
                        ).includes('tail -c')
                            ? 'Error: startup failed\n'
                            : '',
                    }),
            }
        );
        const sandbox = await fake.sandbox();
        const err: string[] = [];
        const process = await sandbox.start('claude -p', {
            stdin: true,
            onStdout: () => {},
            onStderr: (data) => void err.push(data),
        });
        const socket = await opened;
        await process.sendStdin('{"type":"user"}\n');
        // The write asked the toolbox once whether the command had exited.
        expect(statuses).toBe(1);
        expect(err).toEqual([]);
        socket.close();
        expect(await process.wait()).toEqual({ code: 1, stdout: '', stderr: '' });
        expect(err).toEqual(['Error: startup failed\n']);
    });

    test('a write to a command whose exit the follower has seen does not fail', async () => {
        let statuses = 0;
        const fake = logToolbox((_index, socket) => socket.close(), {
            status: () => {
                statuses++;
                return json({ id: 'cmd-1', exitCode: 2 });
            },
            input: () => inputPipeGone(),
        });
        const sandbox = await fake.sandbox();
        const process = await sandbox.start('pi --mode rpc', { stdin: true });
        expect((await process.wait()).code).toBe(2);
        const read = statuses;
        await process.sendStdin('{"type":"get_state"}\n');
        // What the follower already knows needs no further status read.
        expect(statuses).toBe(read);
    });

    test('a write that fails while the command runs still throws', async () => {
        const fake = logToolbox(() => {}, {
            input: () => json({ message: 'toolbox unavailable' }, 500),
        });
        const sandbox = await fake.sandbox();
        const process = await sandbox.start('cat', { stdin: true });
        await expect(process.sendStdin('hello\n')).rejects.toMatchObject({
            name: 'DaytonaApiError',
            status: 500,
        });
        await process.kill();
        expect((await process.wait()).code).toBe(143);
    });

    test('keeps the exit code when the log stream cannot be opened', async () => {
        const fake = logToolbox(() => {}, {
            refuse: true,
            status: () => json({ id: 'cmd-1', exitCode: 5 }),
        });
        const sandbox = await fake.sandbox();
        const process = await sandbox.start('job', {});
        expect(await process.wait()).toEqual({ code: 5, stdout: '', stderr: '' });
        expect(fake.requests.at(-1)?.method).toBe('DELETE');
    });

    test('fails on a status reply that does not identify the command', async () => {
        let statuses = 0;
        const fake = logToolbox((_index, socket) => socket.close(), {
            status: () => {
                statuses++;
                return json({ message: 'proxy page' });
            },
        });
        const sandbox = await fake.sandbox();
        const process = await sandbox.start('job', {});
        await expect(process.wait()).rejects.toMatchObject({
            name: 'RuntimeError',
            message:
                'Daytona toolbox returned an unexpected command status: expected JSON with the command id',
        });
        expect(statuses).toBe(1);
        expect(fake.requests.at(-1)?.method).toBe('DELETE');
    });

    test('keeps following through a status reply that is not JSON', async () => {
        let statuses = 0;
        const fake = logToolbox(
            (_index, socket) => {
                socket.send(framed('stdout', 'ok'));
                socket.close();
            },
            {
                status: () =>
                    ++statuses === 1
                        ? new Response('<html>bad gateway</html>')
                        : json({ id: 'cmd-1', exitCode: 0 }),
            }
        );
        const sandbox = await fake.sandbox();
        const process = await sandbox.start('job', {});
        expect(await process.wait()).toEqual({ code: 0, stdout: 'ok', stderr: '' });
        expect(statuses).toBe(2);
        expect(fake.connections()).toBe(2);
    });
});
