import { describe, expect, test } from 'bun:test';

import { type Handler, json, startedSandbox } from './http.js';

/** Routes a background command's session, exec, logs, and status requests. */
function session(handlers: { logs: Handler; status: Handler }): Handler {
    return (request) => {
        const path = request.url.pathname.replace('/toolbox/sandbox-1', '');
        if (path === '/process/session') return json({});
        if (path.endsWith('/exec')) return json({ cmdId: 'cmd-1' });
        if (path.endsWith('/logs')) return handlers.logs(request);
        if (path.endsWith('/command/cmd-1')) return handlers.status(request);
        return json({});
    };
}

describe('SessionProcess', () => {
    test('streams a background command by following its logs', async () => {
        let polls = 0;
        const { sandbox, requests } = await startedSandbox(
            session({
                logs: () => {
                    polls++;
                    return json({
                        stdout: polls < 2 ? 'one' : 'one two',
                        stderr: polls < 2 ? '' : 'warn',
                    });
                },
                status: () =>
                    json(polls >= 2 ? { id: 'cmd-1', exitCode: 0 } : { id: 'cmd-1' }),
            })
        );
        const out: string[] = [];
        const err: string[] = [];
        const process = await sandbox.start('opencode serve', {
            cwd: '/workspace',
            env: { TOKEN: "it's" },
            onStdout: (data) => void out.push(data),
            onStderr: (data) => void err.push(data),
        });
        expect(await process.wait()).toEqual({
            code: 0,
            stdout: 'one two',
            stderr: 'warn',
        });
        expect(out.join('')).toBe('one two');
        expect(out.length).toBeGreaterThan(1);
        expect(err.join('')).toBe('warn');
        const exec = requests.find((request) => request.url.pathname.endsWith('/exec'));
        const body = JSON.parse(String(exec?.body));
        expect(body.runAsync).toBe(true);
        expect(body.command).toBe(`(cd '/workspace' && opencode serve)`);
        expect(body.envs).toEqual({ TOKEN: "it's" });
        // The session is removed once the command ends.
        expect(requests.at(-1)?.method).toBe('DELETE');
    });

    test('backs off polling while output is unchanged and resets on new output', async () => {
        const polls: number[] = [];
        const { sandbox } = await startedSandbox(
            session({
                logs: () => {
                    polls.push(performance.now());
                    return json({
                        stdout: polls.length < 6 ? '' : 'output',
                        stderr: '',
                    });
                },
                status: () =>
                    json(
                        polls.length >= 8
                            ? { id: 'cmd-1', exitCode: 0 }
                            : { id: 'cmd-1' }
                    ),
            }),
            { pollIntervalMs: 10 }
        );
        const process = await sandbox.start('quiet', {});
        expect(await process.wait()).toMatchObject({ code: 0, stdout: 'output' });
        const gaps = polls.slice(1).map((time, index) => time - (polls[index] ?? 0));
        // Idle polls wait 20, 40, 80, 160 ms; a poll that finds output resets to 10.
        expect(Math.max(...gaps.slice(0, 5))).toBeGreaterThanOrEqual(120);
        expect(gaps[5] ?? Infinity).toBeLessThan(60);
    });

    test('sends input to a background command and kills it by ending its session', async () => {
        const { sandbox, requests } = await startedSandbox(
            session({
                logs: () => json({ stdout: '', stderr: '' }),
                status: () => json({ id: 'cmd-1' }),
            })
        );
        const process = await sandbox.start('cat', { stdin: true });
        await process.sendStdin('hello\n');
        const input = requests.find((request) =>
            request.url.pathname.endsWith('/input')
        );
        expect(JSON.parse(String(input?.body))).toEqual({ data: 'hello\n' });
        await process.kill();
        expect((await process.wait()).code).toBe(143);
        expect(requests.some((request) => request.method === 'DELETE')).toBeTrue();
    });

    test('keeps the exit code when the last log read fails and still ends the session', async () => {
        let logReads = 0;
        const { sandbox, requests } = await startedSandbox(
            session({
                logs: () => {
                    logReads++;
                    // The first read follows the first status poll. The read after
                    // the exit code is seen is the one that fails.
                    return logReads === 1
                        ? json({ stdout: 'done', stderr: '' })
                        : new Response('bad gateway', { status: 502 });
                },
                status: () => json({ id: 'cmd-1', exitCode: logReads >= 1 ? 3 : null }),
            })
        );
        const process = await sandbox.start('job', {});
        expect(await process.wait()).toEqual({ code: 3, stdout: 'done', stderr: '' });
        expect(logReads).toBe(2);
        expect(requests.at(-1)?.method).toBe('DELETE');
    });

    test('keeps the exit code when every log read fails', async () => {
        const { sandbox, requests } = await startedSandbox(
            session({
                logs: () => new Response('bad gateway', { status: 502 }),
                status: () => json({ id: 'cmd-1', exitCode: 5 }),
            })
        );
        const process = await sandbox.start('job', {});
        expect(await process.wait()).toEqual({ code: 5, stdout: '', stderr: '' });
        expect(requests.at(-1)?.method).toBe('DELETE');
    });

    test('fails on a reply that does not identify the command', async () => {
        let polls = 0;
        const { sandbox } = await startedSandbox(
            session({
                logs: () => json({ stdout: '', stderr: '' }),
                status: () => {
                    polls++;
                    return json({ message: 'proxy page' });
                },
            })
        );
        const process = await sandbox.start('job', {});
        await expect(process.wait()).rejects.toMatchObject({
            name: 'RuntimeError',
            message:
                'Daytona toolbox returned an unexpected command status: expected JSON with the command id',
        });
        expect(polls).toBe(1);
    });

    test('keeps polling through a brief proxy failure', async () => {
        let statuses = 0;
        const { sandbox } = await startedSandbox(
            session({
                logs: () => json({ stdout: 'ok', stderr: '' }),
                status: () => {
                    statuses++;
                    return statuses === 1
                        ? new Response('bad gateway', { status: 502 })
                        : json({ id: 'cmd-1', exitCode: 0 });
                },
            })
        );
        const process = await sandbox.start('job', {});
        expect(await process.wait()).toMatchObject({ code: 0, stdout: 'ok' });
        expect(statuses).toBe(2);
    });
});
