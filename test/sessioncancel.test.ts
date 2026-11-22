import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Connection } from '../src/database/connection.js';
import { ProcessTree } from '../src/processes/tree.js';
import { RunControl } from '../src/runs/control.js';
import { RunStore } from '../src/runs/store.js';
import { RunTermination } from '../src/runs/termination.js';
import { DockerRunContainers } from '../src/runtimes/docker/liveness.js';
import { SessionControl } from '../src/sessions/control.js';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

test.each([false, true])(
    'cancel of a process that ignores it returns at the 30 second bound and records cancelled (receipt: %s)',
    async (receipt) => {
        const home = await mkdtemp(join(tmpdir(), 'workbench-cancel-'));
        cleanups.push(() => rm(home, { recursive: true, force: true }));
        const connection = Connection.open(home);
        cleanups.push(() => connection.close());
        const runs = new RunStore(connection, home, { alive: () => true });
        const run = await runs.create({
            metadata: {
                workbench: 'fixture',
                workbench_version: '1.0.0',
                runner: 'opencode',
                model: 'fixture/model',
                runtime: 'docker',
                workspace: home,
                mode: 'detached',
                pid: 1234,
            },
            request: { workbench_path: home, workspace: home, task: 'wait' },
        });
        await runs.update(run.id, { status: 'running' });
        const deadline = Promise.withResolvers<void>();
        const waiting = Promise.withResolvers<void>();
        const delay = spyOn(connection, 'delay').mockImplementation(
            async (milliseconds, signal) => {
                if (milliseconds === 30_000) {
                    return deadline.promise;
                }
                if (receipt && milliseconds === 50) {
                    const channel = new RunControl(connection, run.id);
                    const request = await channel.receive();
                    if (!request) throw new Error('Missing cancel request');
                    await channel.resolve(request, {
                        outcome: 'accepted',
                        disposition: 'cancellation_requested',
                    });
                    return;
                }
                waiting.resolve();
                return new Promise((resolve) =>
                    signal?.addEventListener('abort', () => resolve(), { once: true })
                );
            }
        );
        cleanups.push(() => delay.mockRestore());
        const killed: number[] = [];
        const commands: string[][] = [];
        const containers = new DockerRunContainers(
            {
                findExecutable: () => 'docker',
                command: async (command, options) => {
                    expect(options?.timeout).toBe(10_000);
                    commands.push(command);
                    return {
                        code: 0,
                        stdout: command.includes('ls') ? 'abcdef123456\n' : '',
                        stderr: '',
                    };
                },
            },
            {}
        );
        const termination = new RunTermination(
            runs,
            new ProcessTree({ descendants: () => [2345, 3456] }, (pid) => {
                killed.push(pid);
            }),
            containers
        );
        const unused = async (): Promise<never> => {
            throw new Error('Unexpected control operation');
        };
        const control = new SessionControl(
            connection,
            {
                resolve: async () => ({
                    id: run.id,
                    run: await runs.read(run.id),
                    resumable: false,
                }),
            },
            runs,
            { snapshot: unused },
            { submit: unused },
            { resolve: unused }
        );
        let returned = false;
        const cancelling = control.cancel(run.id, termination).then((receipt) => {
            returned = true;
            return receipt;
        });
        await waiting.promise;
        expect(returned).toBe(false);
        expect(killed).toEqual([]);
        deadline.resolve();
        expect(await cancelling).toMatchObject({ run_id: run.id });
        expect(killed).toEqual([3456, 2345, 1234]);
        expect(commands[0]).toContain(`label=dev.workbenches.run=${run.id}`);
        expect(commands[1]).toContain('abcdef123456');
        expect((await runs.read(run.id)).status).toBe('cancelled');
        expect((await runs.readEvents(run.id)).map((event) => event.type)).toEqual([
            'run.cancelled',
        ]);
    }
);

test('docker liveness probes and removals bound every CLI call and treat timeout as unknown', async () => {
    const calls: string[][] = [];
    const containers = new DockerRunContainers(
        {
            findExecutable: () => 'docker',
            command: async (command, options) => {
                expect(options?.timeout).toBe(10_000);
                calls.push(command);
                return { code: 137, stdout: '', stderr: '' };
            },
        },
        {}
    );
    expect(await containers.exists('wb_fixture')).toBeUndefined();
    expect(calls).toHaveLength(1);
});
