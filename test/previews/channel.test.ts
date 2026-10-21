import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { WorkbenchFiles } from '../../src/files/layout.js';
import { PreviewChannel } from '../../src/previews/channel.js';
import { RunEvents, type WorkbenchEvent } from '../../src/runs/events.js';
import { RunStore } from '../../src/runs/store.js';
import { listen } from './fixture.js';

const directories: string[] = [];
const servers: Bun.Server<undefined>[] = [];

afterEach(async () => {
    for (const server of servers.splice(0)) server.stop(true);
    await Promise.all(
        directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
    );
});

async function fixture(reserved: number[] = []) {
    const home = await mkdtemp(join(tmpdir(), 'workbench-preview-channel-'));
    directories.push(home);
    const runId = RunStore.createId();
    const seen: WorkbenchEvent[] = [];
    const warnings: string[] = [];
    let notify = () => {};
    const events = new RunEvents({
        runId,
        runner: 'fixture',
        onEvent: (event) => {
            seen.push(event);
            notify();
        },
    });
    const channel = new PreviewChannel({
        home,
        runId,
        events,
        reserved: () => reserved,
        warn: (message) => warnings.push(message),
    });
    await channel.install();
    const environment = channel.environment({ PATH: process.env.PATH });
    const wbx = async (...args: string[]) => {
        const child = Bun.spawn(['sh', '-c', 'exec wbx "$@"', 'wbx', ...args], {
            env: environment,
            stdout: 'pipe',
            stderr: 'pipe',
        });
        const [stdout, code] = await Promise.all([
            new Response(child.stdout).text(),
            child.exited,
        ]);
        return { stdout, code };
    };
    const next = () =>
        new Promise<void>((resolve) => {
            notify = resolve;
        });
    return { home, runId, channel, environment, seen, warnings, wbx, next };
}

function server(): number {
    const started = listen();
    servers.push(started);
    return started.port ?? 0;
}

describe('preview channel', () => {
    test('puts wbx first on the runner PATH and keeps it inside the run work directory', async () => {
        const { home, runId, environment } = await fixture();
        const files = new WorkbenchFiles(home);
        expect(environment.PATH?.split(':')[0]).toBe(files.helperDirectory(runId));
        expect(files.helperDirectory(runId)).not.toStartWith(
            files.outboxDirectory(runId)
        );
        expect(files.previewDirectory(runId)).not.toStartWith(
            files.outboxDirectory(runId)
        );
        expect((await stat(files.helperDirectory(runId))).mode & 0o777).toBe(0o700);
        expect((await stat(files.previewDirectory(runId))).mode & 0o777).toBe(0o700);
    });

    test('publishes an announcement as soon as the watcher sees it', async () => {
        const { channel, seen, wbx, next, runId } = await fixture();
        channel.watch();
        const port = server();
        const published = next();
        expect((await wbx('preview', String(port), '--name', 'demo')).code).toBe(0);
        await published;
        expect(seen).toEqual([
            expect.objectContaining({
                run_id: runId,
                type: 'preview.available',
                data: {
                    name: 'demo',
                    port,
                    protocol: 'http',
                    url: `http://127.0.0.1:${port}/`,
                },
            }),
        ]);
        await channel.remove();
    });

    test('refresh picks up announcements without a watcher, and close publishes nothing after', async () => {
        const { channel, seen, wbx } = await fixture();
        const first = server();
        await wbx('preview', String(first), '--name', 'demo');
        await channel.refresh();
        await channel.close();
        await wbx('preview', String(server()), '--name', 'late');
        await channel.refresh();
        expect(seen.map((event) => event.data)).toEqual([
            expect.objectContaining({ name: 'demo', port: first }),
        ]);
    });

    test('warns instead of publishing a reserved port', async () => {
        const port = server();
        const { channel, seen, warnings, wbx } = await fixture([port]);
        await wbx('preview', String(port), '--name', 'runner');
        await channel.close();
        expect(seen).toEqual([]);
        expect(warnings).toEqual([
            `Ignored a preview announcement: port ${port} of runner is reserved by the engine`,
        ]);
    });

    test('removes the helper and control file', async () => {
        const { home, runId, channel } = await fixture();
        channel.watch();
        await channel.remove();
        await channel.remove();
        const files = new WorkbenchFiles(home);
        expect(await readdir(join(files.root, 'work'))).toEqual([]);
        await expect(stat(files.workDirectory(runId))).rejects.toThrow();
    });
});
