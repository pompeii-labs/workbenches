import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { RegistryAccountStore } from '../../src/registry/account-store.js';
import { RegistryClient } from '../../src/registry/client.js';
import { seedModelCatalogFixture } from '../model-catalog-fixture.js';
import { FakeWorkerServer, WORKER_KEY } from './fixture.js';

setDefaultTimeout(30_000);

const LOGIN_KEY = 'wbcli_placeholder_login_key';

const cliPath = resolve(import.meta.dir, '..', '..', 'src', 'cli.ts');
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/**
 * A throwaway machine: a Workbench home, a user home, and fake `docker`,
 * `loginctl`, and `systemctl` on PATH. The fake `systemctl --user restart`
 * starts the daemon from the unit's ExecStart line, as systemd would.
 */
async function machine() {
    const root = await mkdtemp(join(tmpdir(), 'workbench-worker-cli-'));
    const bin = join(root, 'bin');
    const user = join(root, 'user');
    const home = join(root, 'workbench');
    await Promise.all([mkdir(bin), mkdir(user), mkdir(home)]);
    await seedModelCatalogFixture(join(home, 'worker'));
    const script = async (name: string, body: string) => {
        await writeFile(join(bin, name), `#!/bin/sh\n${body}\n`);
        await chmod(join(bin, name), 0o755);
    };
    await script('docker', 'echo 27.3.1');
    await script('loginctl', 'echo "$@" >> "$WB_TEST_RECORD"');
    await script(
        'systemctl',
        [
            'echo "$@" >> "$WB_TEST_RECORD"',
            'case "$*" in',
            '  *restart*)',
            '    command=$(sed -n "s/^ExecStart=//p" "$HOME/.config/systemd/user/workbench-worker.service")',
            '    ( eval "exec $command" ) < /dev/null > /dev/null 2>&1 &',
            '    echo $! > "$WB_TEST_PID"',
            '    ;;',
            '  *is-active*) echo active ;;',
            'esac',
        ].join('\n')
    );
    const server = new FakeWorkerServer();
    server.routes.set('POST /v1/workers', () =>
        Response.json(
            {
                worker: { id: 'wrk_1', slug: 'mini', name: 'mini', shared: false },
                key: WORKER_KEY,
            },
            { status: 201 }
        )
    );
    // The person's own `wb login`, which registration uses.
    await new RegistryAccountStore({
        home,
        client: new RegistryClient({ home, apiUrl: server.url }),
    }).save({
        organizationId: 'org_1',
        slug: 'acme',
        name: 'Acme',
        personal: false,
        token: LOGIN_KEY,
        keyId: 'key_1',
        scopes: [],
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    server.routes.set(
        'DELETE /v1/workers/self',
        () => new Response(null, { status: 204 })
    );
    const pidFile = join(root, 'daemon.pid');
    cleanups.push(async () => {
        const pid = Number(await readFile(pidFile, 'utf8').catch(() => ''));
        if (pid) {
            try {
                process.kill(pid, 'SIGKILL');
            } catch {
                // Already exited.
            }
        }
        server.stop();
        await rm(root, { recursive: true, force: true });
    });
    const env = {
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        HOME: user,
        WORKBENCH_HOME: home,
        WB_TEST_RECORD: join(root, 'record'),
        WB_TEST_PID: pidFile,
        NO_COLOR: '1',
    };
    const cli = async (args: string[]) => {
        const child = Bun.spawn(
            [process.execPath, cliPath, ...args, '--api-url', server.url],
            {
                env,
                stdin: 'ignore',
                stdout: 'pipe',
                stderr: 'pipe',
            }
        );
        const [stdout, stderr, code] = await Promise.all([
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
            child.exited,
        ]);
        return { stdout, stderr, code };
    };
    return {
        root,
        home,
        server,
        cli,
        record: () => readFile(join(root, 'record'), 'utf8'),
    };
}

describe('wb worker', () => {
    test.if(process.platform === 'linux')(
        'registers, starts online, reports status and logs, stops, and removes',
        async () => {
            const { server, cli, record, home } = await machine();

            const started = await cli([
                'worker',
                'start',
                '--name',
                'mini',
                '--runtimes',
                'docker',
            ]);
            expect(started.stderr).toBe('');
            expect(started).toMatchObject({
                code: 0,
                stdout: 'Worker mini is online for acme. 1 slot, runtimes docker. Follow it with: wb worker logs -f\n',
            });
            expect(await record()).toContain('--user enable workbench-worker.service');
            const hello = await server.next((message) => message.type === 'hello');
            expect(hello).toMatchObject({
                protocol: 1,
                runtimes: ['docker'],
                slots: 1,
            });

            server.send({
                type: 'run.start',
                run_id: 'run_local',
                session_id: 'ses_1',
                started_by: { member_id: null },
                runtime: 'local',
                workbench: {
                    version_id: 'wv_1',
                    download_url: `${server.url}/package`,
                },
                image_pull: null,
                task: 'Build it',
                max_minutes: 60,
                workspace: null,
                env: {},
                connection: null,
                run_token: 'placeholder-run-token',
            });
            expect(
                await server.next((message) => message.type === 'run.rejected')
            ).toMatchObject({
                run_id: 'run_local',
                reason: 'This worker does not offer the local runtime. It offers docker',
            });

            const status = await cli(['worker', 'status', '--json']);
            expect(JSON.parse(status.stdout)).toMatchObject({
                registered: true,
                name: 'mini',
                online: true,
                slots: 1,
                runtimes: ['docker'],
                runs: [],
            });

            const logs = await cli(['worker', 'logs']);
            expect(logs.stdout).toMatch(
                /^\[mini\] \d\d:\d\d:\d\d online, 1 slot, docker 27\.3\.1, runtimes docker\n/
            );
            expect(logs.stdout).toContain(
                'rejected a run  This worker does not offer the local runtime'
            );

            const stopped = await cli(['worker', 'stop']);
            expect(stopped).toMatchObject({
                code: 0,
                stdout: 'Worker mini stopped.\n',
            });
            expect(await record()).toContain(
                '--user disable --now workbench-worker.service'
            );
            expect(
                JSON.parse((await cli(['worker', 'status', '--json'])).stdout)
            ).toMatchObject({
                online: false,
                running: false,
            });

            const removed = await cli(['worker', 'remove']);
            expect(removed).toMatchObject({
                code: 0,
                stdout: 'Worker mini removed. Its key is revoked.\n',
            });
            expect(server.requests.at(-1)).toMatchObject({
                method: 'DELETE',
                path: '/v1/workers/self',
                authorization: `Bearer ${WORKER_KEY}`,
            });
            expect(await Bun.file(join(home, 'worker', 'worker.json')).exists()).toBe(
                false
            );
        }
    );

    test('registers through the CLI login, then refuses to start without a runtime to offer', async () => {
        const { cli, root, server, home } = await machine();
        await writeFile(join(root, 'bin', 'docker'), '#!/bin/sh\nexit 1\n');
        const started = await cli([
            'worker',
            'start',
            '--name',
            'mini',
            '--runtimes',
            'docker',
        ]);
        expect(started.code).toBe(1);
        expect(started.stderr).toContain(
            'This worker has no runtime to offer: Docker is not running'
        );
        expect(server.requests[0]).toMatchObject({
            method: 'POST',
            path: '/v1/workers',
            authorization: `Bearer ${LOGIN_KEY}`,
            body: JSON.stringify({ name: 'mini' }),
        });
        expect(
            await Bun.file(join(home, 'worker', 'worker.json')).json()
        ).toMatchObject({
            name: 'mini',
            organization: 'acme',
        });
        const renamed = await cli(['worker', 'start', '--name', 'studio']);
        expect(renamed.code).toBe(1);
        expect(renamed.stderr).toContain(
            'This machine is already the worker mini. Run wb worker remove first.'
        );
        expect(server.requests).toHaveLength(1);
    });

    test('requires a name to register before starting', async () => {
        const { cli, server } = await machine();
        const started = await cli(['worker', 'start']);
        expect(started.code).toBe(1);
        expect(started.stderr).toContain('This machine is not registered as a worker');
        expect(server.requests).toEqual([]);
    });
});
