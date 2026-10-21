import { afterEach, describe, expect, test } from 'bun:test';

import type { FollowedCommand } from '../../../src/runtimes/daytona/follow.js';
import { client, json, type Recorded } from './http.js';

const servers: Bun.Server<undefined>[] = [];

afterEach(() => {
    for (const server of servers.splice(0)) server.stop(true);
});

const stdout = new Uint8Array([1, 1, 1]);
const stderr = new Uint8Array([2, 2, 2]);
const encode = (text: string) => new TextEncoder().encode(text);
const join = (...parts: Uint8Array[]) => {
    const joined = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
    let offset = 0;
    for (const part of parts) {
        joined.set(part, offset);
        offset += part.length;
    }
    return joined;
};

interface Socket {
    send(data: Uint8Array | string): void;
    close(): void;
}

/**
 * A toolbox whose log stream is a real local WebSocket. `connected` runs for
 * each connection with its index. `refuse` answers the upgrade with an error.
 */
function toolbox(
    connected: (index: number, socket: Socket) => void,
    options: { refuse?: boolean; exited?: () => boolean } = {}
) {
    const upgrades: Array<{ path: string; authorization: string | null }> = [];
    let connections = 0;
    const server = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        fetch(request, server) {
            const url = new URL(request.url);
            upgrades.push({
                path: `${url.pathname}${url.search}`,
                authorization: request.headers.get('authorization'),
            });
            if (options.refuse) return new Response('bad gateway', { status: 502 });
            if (server.upgrade(request)) return undefined;
            return new Response('expected a WebSocket', { status: 400 });
        },
        websocket: {
            open(socket) {
                connected(connections++, socket);
            },
            message() {},
        },
    });
    servers.push(server);
    const handler = (request: Recorded) => {
        const path = request.url.pathname;
        if (request.method === 'POST' && path === '/api/sandbox')
            return json({ id: 'sandbox-1', state: 'started', labels: {} });
        if (request.method === 'GET' && path === '/api/sandbox/sandbox-1')
            return json({
                id: 'sandbox-1',
                state: 'started',
                toolboxProxyUrl: `http://127.0.0.1:${server.port}/toolbox/`,
            });
        if (path.endsWith('/exec')) return json({ cmdId: 'cmd-1' });
        if (request.method === 'GET' && path.endsWith('/command/cmd-1'))
            return json({ id: 'cmd-1', exitCode: options.exited?.() ? 0 : null });
        return json({});
    };
    const { api, requests } = client(handler);
    return {
        upgrades,
        requests,
        connections: () => connections,
        sandbox: () =>
            api.createSandbox({
                image: 'debian:bookworm-slim',
                labels: {},
                leaseMinutes: 5,
            }),
    };
}

/** Keeps only bytes past what it has already seen, as the announcement log does. */
function receiver() {
    let seen = 0;
    let text = '';
    const calls: number[] = [];
    return {
        output: (bytes: Uint8Array, start: number) => {
            calls.push(start);
            const skip = seen - start;
            if (skip < 0 || skip >= bytes.length) return;
            text += new TextDecoder().decode(bytes.subarray(skip));
            seen += bytes.length - skip;
        },
        text: () => text,
        calls,
    };
}

async function until(condition: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 500 && !condition(); attempt++) await Bun.sleep(5);
    expect(condition()).toBeTrue();
}

describe('Daytona log follower', () => {
    let followed: FollowedCommand | undefined;
    afterEach(async () => {
        await followed?.stop();
        followed = undefined;
    });

    test('streams output as it is written and reconnects without losing or repeating it', async () => {
        const first = '{"name":"demo","port":5173}\n';
        const second = '{"name":"game","port":8080}\n';
        const third = '{"name":"docs","port":3000}\n';
        const fake = toolbox((index, socket) => {
            if (index === 0) {
                // A marker split across messages still starts standard output.
                socket.send(stdout.subarray(0, 2));
                socket.send(join(stdout.subarray(2), encode(first)));
                socket.send(encode(second.slice(0, 10)));
                socket.close();
                return;
            }
            // Every connection replays the output from its start.
            socket.send(join(stdout, encode(first + second)));
            socket.send(join(stderr, encode('tail: file truncated\n')));
            socket.send(join(stdout, encode(third)));
        });
        const sandbox = await fake.sandbox();
        const received = receiver();
        const failures: unknown[] = [];
        if (!sandbox.follow) throw new Error('DaytonaToolbox follows commands');
        followed = await sandbox.follow(
            "exec tail -n +1 -F '/opt/workbench/previews/announcements.jsonl'",
            received.output,
            (error) => failures.push(error)
        );
        await until(() => received.text() === first + second + third);
        expect(fake.connections()).toBe(2);
        expect(failures).toEqual([]);
        expect(received.calls[0]).toBe(0);
        expect(fake.upgrades).toEqual([
            {
                path:
                    '/toolbox/sandbox-1/process/session/' +
                    sessionOf(fake.requests) +
                    '/command/cmd-1/logs?follow=true',
                authorization: 'Bearer secret-api-key',
            },
            expect.objectContaining({ authorization: 'Bearer secret-api-key' }),
        ]);
        const exec = fake.requests.find((request) =>
            request.url.pathname.endsWith('/exec')
        );
        expect(JSON.parse(String(exec?.body))).toMatchObject({
            command:
                "(exec tail -n +1 -F '/opt/workbench/previews/announcements.jsonl')",
            runAsync: true,
        });
        // Nothing polls the command's logs over HTTP.
        expect(
            fake.requests.filter((request) => request.url.pathname.endsWith('/logs'))
        ).toEqual([]);
        await followed.stop();
        followed = undefined;
        expect(
            fake.requests.filter((request) => request.method === 'DELETE')
        ).toHaveLength(1);
    });

    test('stops reconnecting once the command has exited', async () => {
        let exited = false;
        const fake = toolbox(
            (_index, socket) => {
                socket.send(join(stdout, encode('done\n')));
                exited = true;
                socket.close();
            },
            { exited: () => exited }
        );
        const sandbox = await fake.sandbox();
        const received = receiver();
        followed = await sandbox.follow?.('exec true', received.output, () => {});
        await until(() => received.text() === 'done\n');
        await Bun.sleep(50);
        expect(fake.connections()).toBe(1);
    });

    test('gives up after several connections in a row fail and reports it', async () => {
        const fake = toolbox(() => {}, { refuse: true });
        const sandbox = await fake.sandbox();
        const failures: unknown[] = [];
        followed = await sandbox.follow?.(
            'exec true',
            () => {},
            (error) => failures.push(error)
        );
        await until(() => failures.length === 1);
        expect(fake.upgrades).toHaveLength(5);
        expect(String(failures[0])).not.toContain('secret-api-key');
    });
});

function sessionOf(requests: Recorded[]): string {
    const created = requests.find(
        (request) =>
            request.method === 'POST' &&
            request.url.pathname.endsWith('/process/session')
    );
    const body: unknown = JSON.parse(String(created?.body));
    if (typeof body !== 'object' || body === null || !('sessionId' in body))
        throw new Error('No session was created');
    return String(body.sessionId);
}
