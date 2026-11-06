import { afterEach, expect, test } from 'bun:test';
import { RuntimeProcessMissingError } from '../../../src/runtimes/missing.js';
import {
    cleanTemporaryDirectories,
    daytonaProvider,
    FakeClient,
    fixture,
    request,
} from './fixture.js';
import { json } from './http.js';
import { framed, logToolbox, stopLogServers } from './logs.js';

afterEach(stopLogServers);
afterEach(cleanTemporaryDirectories);

test('attaches to an existing command, replays stdout, writes stdin, and collects stderr at exit', async () => {
    const fake = logToolbox(
        (_index, socket) => {
            socket.send(framed('stdout', 'saved\nfresh\n'));
            socket.close();
        },
        {
            status: () => json({ id: 'cmd-1', exitCode: 7 }),
            execute: () => json({ exitCode: 0, result: 'diagnostic\n' }),
        }
    );
    const sandbox = await fake.sandbox();
    const out: string[] = [];
    const err: string[] = [];
    const handle = {
        runtime: 'daytona' as const,
        sandboxId: sandbox.id,
        sessionId: 'wb-existing',
        commandId: 'cmd-1',
        stderrPath: '/tmp/.workbench-stderr-0d9c6f1e-5b7a-4c3e-9f2d-8a1b2c3d4e5f',
    };
    const command = await sandbox.attachSession?.(handle, {
        onStdout: (text) => {
            out.push(text);
        },
        onStderr: (text) => {
            err.push(text);
        },
    });
    expect(command).toBeDefined();
    await command?.sendStdin('answer\n');
    expect(await command?.wait()).toEqual({ code: 7, stdout: '', stderr: '' });
    expect(out.join('')).toBe('saved\nfresh\n');
    expect(err).toEqual(['diagnostic\n']);
    expect(fake.requests.some((r) => r.url.pathname.endsWith('/exec'))).toBe(false);
    expect(fake.requests.some((r) => r.url.pathname.endsWith('/input'))).toBe(true);
    expect(command?.handle).toEqual(handle);
});

test('refuses a saved stderr path that Workbench did not create, before any request', async () => {
    const fake = logToolbox(() => {});
    const sandbox = await fake.sandbox();
    const before = fake.requests.length;
    await expect(
        sandbox.attachSession?.(
            {
                runtime: 'daytona',
                sandboxId: sandbox.id,
                sessionId: 'wb-existing',
                commandId: 'cmd-1',
                stderrPath: '/home/daytona/.ssh/authorized_keys',
            },
            {}
        )
    ).rejects.toThrow('not one Workbench created');
    expect(fake.requests).toHaveLength(before);
});

test('a missing attached command has a typed error distinct from transport failure', async () => {
    for (const status of [404, 503]) {
        const fake = logToolbox(() => {}, { status: () => json({}, status) });
        const sandbox = await fake.sandbox();
        const attaching = sandbox.attachSession?.(
            {
                runtime: 'daytona',
                sandboxId: sandbox.id,
                sessionId: 'wb-existing',
                commandId: 'cmd-1',
            },
            {}
        );
        if (status === 404)
            await expect(attaching).rejects.toBeInstanceOf(RuntimeProcessMissingError);
        else
            await expect(attaching).rejects.not.toBeInstanceOf(
                RuntimeProcessMissingError
            );
    }
});

for (const stopping of ['cancel', 'cleanup'] as const) {
    test(`runtime ${stopping} stops an attached toolbox command`, async () => {
        const fake = logToolbox((_index, socket) =>
            socket.send(framed('stdout', 'running\n'))
        );
        const toolbox = await fake.sandbox();
        const client = new FakeClient();
        Object.assign(client.sandbox, {
            attachSession: toolbox.attachSession?.bind(toolbox),
        });
        const runtime = await daytonaProvider({ client }).prepare(
            request(await fixture())
        );
        try {
            await runtime.preflight();
            const child = runtime.attachSession?.({
                runtime: 'daytona',
                sandboxId: toolbox.id,
                sessionId: 'wb-existing',
                commandId: 'cmd-1',
            });
            expect(child).toBeDefined();
            await child?.handle;
            if (stopping === 'cancel' && child) runtime.cancel(child);
            else await runtime.cleanup();
            expect(await child?.exited).toBe(143);
            expect(
                fake.requests.some(
                    (entry) =>
                        entry.method === 'DELETE' &&
                        entry.url.pathname.endsWith('/wb-existing')
                )
            ).toBe(true);
        } finally {
            await runtime.cleanup();
        }
    });
}

test('a launched command exposes its serializable identity after starting', async () => {
    const fake = logToolbox(() => {});
    const toolbox = await fake.sandbox();
    const command = await toolbox.start('runner', { stdin: true, onStderr: () => {} });
    try {
        expect(command.handle).toMatchObject({
            runtime: 'daytona',
            sandboxId: toolbox.id,
            commandId: 'cmd-1',
        });
        expect(command.handle?.sessionId).toMatch(/^wb-/);
        expect(command.handle?.stderrPath).toMatch(/^\/tmp\/\.workbench-stderr-/);
        expect(JSON.parse(JSON.stringify(command.handle))).toEqual(command.handle);
    } finally {
        await command.kill();
    }
});

test('an exited stdin command keeps its log and stderr available for another attachment', async () => {
    const fake = logToolbox(
        (_index, socket) => {
            socket.send(framed('stdout', 'last\n'));
            socket.close();
        },
        {
            status: () => json({ id: 'cmd-1', exitCode: 9 }),
            execute: () => json({ exitCode: 0, result: 'failure detail\n' }),
        }
    );
    const sandbox = await fake.sandbox();
    const first = await sandbox.start('runner', { stdin: true, onStderr: () => {} });
    expect((await first.wait()).code).toBe(9);
    expect(fake.requests.filter((entry) => entry.method === 'DELETE')).toEqual([]);
    const handle = first.handle;
    if (!handle || !sandbox.attachSession)
        throw new Error('Expected attachable process');
    const second = await sandbox.attachSession(handle, {});
    expect(await second.wait()).toEqual({
        code: 9,
        stdout: 'last\n',
        stderr: 'failure detail\n',
    });
    const reads = fake.requests
        .filter((entry) => entry.url.pathname.endsWith('/execute'))
        .map((entry) => String(entry.body));
    expect(reads.every((line) => !line.includes('rm -f'))).toBe(true);
    await second.kill();
    expect(fake.requests.some((entry) => entry.method === 'DELETE')).toBe(true);
    expect(fake.requests.some((entry) => String(entry.body).includes('rm -f'))).toBe(
        true
    );
});
