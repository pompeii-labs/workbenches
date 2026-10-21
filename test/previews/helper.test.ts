import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PreviewHelper } from '../../src/previews/helper.js';
import { closedPort, listen } from './fixture.js';

const directories: string[] = [];
const servers: Bun.Server<undefined>[] = [];

afterEach(async () => {
    for (const server of servers.splice(0)) server.stop(true);
    await Promise.all(
        directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
    );
});

async function helper() {
    // A quote in the path proves the baked control path is shell-quoted.
    const directory = await mkdtemp(join(tmpdir(), "workbench-wbx-'quoted-"));
    directories.push(directory);
    const control = join(directory, 'announcements.jsonl');
    await writeFile(control, '');
    const path = await new PreviewHelper(control).install(join(directory, 'bin'));
    const run = async (...args: string[]) => {
        const child = Bun.spawn([path, ...args], {
            env: { PATH: process.env.PATH },
            stdout: 'pipe',
            stderr: 'pipe',
        });
        const [stdout, stderr, code] = await Promise.all([
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
            child.exited,
        ]);
        return { stdout, stderr, code };
    };
    return { path, control, run, lines: async () => readFile(control, 'utf8') };
}

function server(): number {
    const started = listen();
    servers.push(started);
    return started.port ?? 0;
}

describe('wbx helper', () => {
    test('installs a private executable named wbx', async () => {
        const { path } = await helper();
        expect(path.endsWith('/bin/wbx')).toBeTrue();
        expect((await stat(path)).mode & 0o777).toBe(0o700);
        expect(await readFile(path, 'utf8')).toStartWith('#!/bin/sh\n');
    });

    test('prints usage and fails for a missing or unknown command', async () => {
        const { run } = await helper();
        const missing = await run();
        expect(missing.code).toBe(2);
        expect(missing.stderr).toContain('Usage: wbx <command>');
        expect(missing.stderr).toContain('preview <port> --name <name>');
        const unknown = await run('deploy');
        expect(unknown.code).toBe(2);
        expect(unknown.stderr).toContain('wbx: unknown command: deploy');
        expect(unknown.stderr).toContain('Usage: wbx <command>');
        const help = await run('--help');
        expect(help.code).toBe(0);
        expect(help.stdout).toContain('Usage: wbx <command>');
        const previewHelp = await run('preview', '--help');
        expect(previewHelp.code).toBe(0);
        expect(previewHelp.stdout).toContain('Usage: wbx preview <port> --name <name>');
    });

    test('rejects invalid arguments before checking the port or recording anything', async () => {
        const { run, lines } = await helper();
        const port = String(server());
        const cases: Array<[string[], string]> = [
            [['preview'], 'a port is required'],
            [['preview', port], '--name is required'],
            [['preview', port, '--name'], '--name requires a value'],
            [['preview', 'abc', '--name', 'demo'], 'the port must be an integer'],
            [['preview', '80', '--name', 'demo'], 'the port must be an integer'],
            [['preview', '70000', '--name', 'demo'], 'the port must be an integer'],
            [['preview', '05173', '--name', 'demo'], 'the port must be an integer'],
            [['preview', '1234567', '--name', 'demo'], 'the port must be an integer'],
            [['preview', port, '--name', 'Demo'], 'must start with a lowercase letter'],
            [
                ['preview', port, '--name', '-demo'],
                'must start with a lowercase letter',
            ],
            [['preview', port, '--name', 'de_mo'], 'only lowercase letters, digits'],
            [['preview', port, '--name', 'de"mo'], 'only lowercase letters, digits'],
            [['preview', port, '--name', 'a'.repeat(41)], 'at most 40 characters'],
            [['preview', port, '--name', 'demo', '--open'], 'unknown option: --open'],
            [['preview', port, port, '--name', 'demo'], `unexpected argument: ${port}`],
        ];
        for (const [args, message] of cases) {
            const result = await run(...args);
            expect({ args, code: result.code }).toEqual({ args, code: 2 });
            expect(result.stderr).toContain(message);
        }
        expect(await lines()).toBe('');
    });

    test('refuses a port nothing listens on', async () => {
        const { run, lines } = await helper();
        const port = await closedPort();
        const result = await run('preview', String(port), '--name', 'demo');
        expect(result.code).toBe(1);
        expect(result.stderr).toContain(
            `nothing is listening on 127.0.0.1:${port}; start the server first`
        );
        expect(await lines()).toBe('');
    });

    test('records one JSON line for a listening port and confirms it', async () => {
        const { run, lines } = await helper();
        const port = server();
        const result = await run('preview', String(port), '--name', 'demo');
        expect(result).toEqual({
            code: 0,
            stdout: `wbx: announced preview demo on port ${port}\n`,
            stderr: '',
        });
        const second = await run('preview', '--name=game-2', String(port));
        expect(second.code).toBe(0);
        expect(await lines()).toBe(
            `{"name":"demo","port":${port}}\n{"name":"game-2","port":${port}}\n`
        );
    });

    test('appends whole lines when announcements race', async () => {
        const { run, lines } = await helper();
        const port = server();
        const names = Array.from({ length: 24 }, (_, index) => `app-${index}`);
        const results = await Promise.all(
            names.map((name) => run('preview', String(port), '--name', name))
        );
        expect(results.map((result) => result.code)).toEqual(names.map(() => 0));
        const recorded = (await lines()).split('\n');
        expect(recorded.pop()).toBe('');
        expect(recorded.map((line) => JSON.parse(line).name).toSorted()).toEqual(
            names.toSorted()
        );
        for (const line of recorded)
            expect(JSON.parse(line)).toEqual({
                name: expect.any(String),
                port,
            });
    });
});
