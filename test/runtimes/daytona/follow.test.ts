import { afterEach, describe, expect, test } from 'bun:test';

import type { FollowedCommand } from '../../../src/runtimes/daytona/follow.js';
import {
    encode,
    join,
    sessionOf,
    stderrMarker as stderr,
    stdoutMarker as stdout,
    stopLogServers,
    logToolbox as toolbox,
} from './logs.js';

afterEach(stopLogServers);

/** Keeps only bytes past what it has already seen, as the announcement log does. */
function receiver() {
    let seen = 0;
    let text = '';
    const calls: Array<{ start: number; length: number }> = [];
    return {
        output: (bytes: Uint8Array, start: number) => {
            calls.push({ start, length: bytes.length });
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
        expect(received.calls[0]?.start).toBe(0);
        // The follower passes on only what is new, so every call starts where the last ended.
        for (const [index, call] of received.calls.entries()) {
            const previous = received.calls[index - 1];
            if (previous) expect(call.start).toBe(previous.start + previous.length);
        }
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

    test('opens every log stream through the socket the host supplies', async () => {
        const opened: Array<{ url: URL; authorization: string | undefined }> = [];
        const socket = async (url: URL, headers: Record<string, string>) => {
            opened.push({ url, authorization: headers.Authorization });
            return new WebSocket(url, { headers } as unknown as string[]);
        };
        let exited = false;
        const fake = toolbox(
            (_index, connection) => {
                connection.send(join(stdout, encode('done\n')));
                exited = true;
                connection.close();
            },
            { exited: () => exited, client: { socket } }
        );
        const sandbox = await fake.sandbox();
        const received = receiver();
        followed = await sandbox.follow?.('exec true', received.output, () => {});
        await until(() => received.text() === 'done\n');
        expect(opened).toHaveLength(1);
        expect(opened[0]?.url.protocol).toBe('ws:');
        expect(opened[0]?.url.pathname).toEndWith('/command/cmd-1/logs');
        expect(opened[0]?.url.searchParams.get('follow')).toBe('true');
        expect(opened[0]?.authorization).toBe('Bearer secret-api-key');
        expect(fake.upgrades).toEqual([
            expect.objectContaining({ authorization: 'Bearer secret-api-key' }),
        ]);
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
