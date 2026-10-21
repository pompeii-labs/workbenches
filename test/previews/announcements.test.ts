import { afterEach, describe, expect, test } from 'bun:test';
import { appendFile, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PreviewAnnouncements } from '../../src/previews/announcements.js';
import { PreviewPolicy } from '../../src/previews/policy.js';
import { LoopbackPorts } from '../../src/previews/probe.js';
import { closedPort, listen } from './fixture.js';

const directories: string[] = [];
const servers: Bun.Server<undefined>[] = [];

afterEach(async () => {
    for (const server of servers.splice(0)) server.stop(true);
    await Promise.all(
        directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
    );
});

async function fixture(reserved: number[] = []) {
    const directory = await mkdtemp(join(tmpdir(), 'workbench-previews-'));
    directories.push(directory);
    const file = join(directory, 'announcements.jsonl');
    await writeFile(file, '');
    const warnings: string[] = [];
    const announcements = new PreviewAnnouncements(
        file,
        new PreviewPolicy(() => reserved),
        new LoopbackPorts(),
        (message) => warnings.push(message)
    );
    const announce = (value: unknown) =>
        appendFile(
            file,
            `${typeof value === 'string' ? value : JSON.stringify(value)}\n`
        );
    return { file, warnings, announcements, announce };
}

function server(): number {
    const started = listen();
    servers.push(started);
    return started.port ?? 0;
}

describe('preview announcements', () => {
    test('accepts a listening port once and reads only new lines', async () => {
        const { announcements, announce, warnings } = await fixture();
        const port = server();
        await announce({ name: 'demo', port });
        expect(await announcements.read()).toEqual([{ name: 'demo', port }]);
        expect(await announcements.read()).toEqual([]);
        await announce({ name: 'demo', port });
        expect(await announcements.read()).toEqual([]);
        expect(warnings).toEqual([]);
    });

    test('replaces a repeated name with its new port', async () => {
        const { announcements, announce } = await fixture();
        const first = server();
        const second = server();
        await announce({ name: 'demo', port: first });
        await announce({ name: 'demo', port: second });
        expect(await announcements.read()).toEqual([
            { name: 'demo', port: first },
            { name: 'demo', port: second },
        ]);
    });

    test('ignores a port that is not listening with a warning', async () => {
        const { announcements, announce, warnings } = await fixture();
        const port = await closedPort();
        await announce({ name: 'demo', port });
        expect(await announcements.read()).toEqual([]);
        expect(warnings).toEqual([
            `Ignored preview demo: nothing is listening on port ${port}`,
        ]);
    });

    test('applies the policy to each line, including reserved ports and the cap', async () => {
        const reservedPort = server();
        const { announcements, announce, warnings } = await fixture([reservedPort]);
        const port = server();
        await announce('garbage');
        await announce({ name: 'Bad', port });
        await announce({ name: 'runner', port: reservedPort });
        for (let index = 0; index < 9; index += 1)
            await announce({ name: `app-${index}`, port });
        const accepted = await announcements.read();
        expect(accepted.map((preview) => preview.name)).toEqual(
            Array.from({ length: 8 }, (_, index) => `app-${index}`)
        );
        expect(warnings).toEqual([
            'Ignored a preview announcement: the announcement is not a JSON object',
            expect.stringContaining('Ignored a preview announcement: the name must be'),
            `Ignored a preview announcement: port ${reservedPort} of runner is reserved by the engine`,
            'Ignored a preview announcement: app-8 exceeds the limit of 8 previews per run',
        ]);
    });

    test('waits for a line to finish and drops one that grows too long', async () => {
        const { file, announcements, warnings } = await fixture();
        const port = server();
        const line = JSON.stringify({ name: 'demo', port });
        await appendFile(file, line.slice(0, 5));
        expect(await announcements.read()).toEqual([]);
        await appendFile(file, `${line.slice(5)}\n`);
        expect(await announcements.read()).toEqual([{ name: 'demo', port }]);
        await appendFile(file, 'x'.repeat(PreviewPolicy.maximumLineBytes + 1));
        expect(await announcements.read()).toEqual([]);
        await appendFile(file, `${JSON.stringify({ name: 'tail', port })}\n`);
        await appendFile(file, `${JSON.stringify({ name: 'next', port })}\n`);
        expect(await announcements.read()).toEqual([{ name: 'next', port }]);
        expect(warnings).toEqual([
            'Ignored a preview announcement: the announcement is too long',
        ]);
    });

    test('refuses to follow a control file replaced by a symlink', async () => {
        const { file, announcements } = await fixture();
        const target = `${file}.target`;
        await writeFile(target, `${JSON.stringify({ name: 'demo', port: 5173 })}\n`);
        await rm(file);
        await symlink(target, file);
        await expect(announcements.read()).rejects.toThrow();
    });
});
