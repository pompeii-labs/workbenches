import { afterEach, describe, expect, test } from 'bun:test';

import { json, type Recorded } from './http.js';
import { encode, logToolbox, stopLogServers } from './logs.js';

afterEach(stopLogServers);

/** The command the toolbox was asked to run in the background. */
function background(requests: Recorded[]): string {
    const exec = requests.find((request) => request.url.pathname.endsWith('/exec'));
    return String(JSON.parse(String(exec?.body)).command);
}

/** The one-shot commands the toolbox was asked to run. */
function executed(requests: Recorded[]): string[] {
    return requests
        .filter((request) => request.url.pathname.endsWith('/process/execute'))
        .map((request) => String(JSON.parse(String(request.body)).command));
}

const stderrPath = /2>'(\/tmp\/\.workbench-stderr-[0-9a-f-]{36})'$/;

/** A command whose merged log stream carries only `output`, then exits with `code`. */
function exitingWith(
    output: string,
    code: number,
    execute?: (request: Recorded) => Response
) {
    let exited = false;
    return logToolbox(
        (_index, socket) => {
            // Today's toolbox sends one merged stream with no markers.
            socket.send(encode(output));
            exited = true;
            socket.close();
        },
        {
            status: () => json({ id: 'cmd-1', exitCode: exited ? code : null }),
            ...(execute ? { execute } : {}),
        }
    );
}

describe('Daytona background standard error', () => {
    test('keeps standard output clean and delivers standard error at exit, then removes its file', async () => {
        const fake = exitingWith('{"type":"result"}\n', 0, (request) => {
            const command = String(JSON.parse(String(request.body)).command);
            return json({
                exitCode: 0,
                result: command.includes('tail -c 65536') ? 'warning: slow\n' : '',
            });
        });
        const sandbox = await fake.sandbox();
        const events: string[] = [];
        const process = await sandbox.start('pi --mode rpc', {
            onStdout: (data) => void events.push(`out:${data}`),
            onStderr: (data) => void events.push(`err:${data}`),
        });
        const result = await process.wait();
        events.push(`exit:${result.code}`);
        expect(events).toEqual([
            'out:{"type":"result"}\n',
            'err:warning: slow\n',
            'exit:0',
        ]);
        const path = background(fake.requests).match(stderrPath)?.[1];
        if (!path) throw new Error('standard error was not redirected to a file');
        const reads = executed(fake.requests);
        // One read takes the last 64 KiB and removes the file in the same command.
        expect(reads).toHaveLength(1);
        expect(reads[0]).toContain(
            `tail -c 65536 '${path}'; S=$?; rm -f '${path}'; exit $S`
        );
    });

    test('a failed read of standard error still resolves with the exit code and removes the file', async () => {
        const fake = exitingWith('partial\n', 3, () =>
            json({ message: 'toolbox unavailable' }, 400)
        );
        const sandbox = await fake.sandbox();
        const err: string[] = [];
        const process = await sandbox.start('claude -p', {
            onStdout: () => {},
            onStderr: (data) => void err.push(data),
        });
        expect((await process.wait()).code).toBe(3);
        expect(err).toEqual([]);
        const path = background(fake.requests).match(stderrPath)?.[1];
        const reads = executed(fake.requests);
        expect(reads).toHaveLength(2);
        expect(reads[1]).toContain(`rm -f '${path}'`);
    });

    test('a killed command removes its file without reading it', async () => {
        const fake = logToolbox(() => {});
        const sandbox = await fake.sandbox();
        const err: string[] = [];
        const process = await sandbox.start('claude -p', {
            onStderr: (data) => void err.push(data),
        });
        await process.kill();
        expect((await process.wait()).code).toBe(143);
        const path = background(fake.requests).match(stderrPath)?.[1];
        const reads = executed(fake.requests);
        expect(reads).toHaveLength(1);
        expect(reads[0]).toContain(`rm -f '${path}'`);
        expect(reads[0]).not.toContain('tail');
        expect(err).toEqual([]);
    });

    test('a command without a standard error receiver keeps the merged stream', async () => {
        const fake = exitingWith('out1\nout2\nerr1\n', 0);
        const sandbox = await fake.sandbox();
        const out: string[] = [];
        const process = await sandbox.start('job', {
            onStdout: (data) => void out.push(data),
        });
        expect(await process.wait()).toEqual({ code: 0, stdout: '', stderr: '' });
        expect(out.join('')).toBe('out1\nout2\nerr1\n');
        expect(background(fake.requests)).toBe('(job)');
        expect(executed(fake.requests)).toEqual([]);
    });
});
