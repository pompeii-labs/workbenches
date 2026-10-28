import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    LaunchdWorkerService,
    SystemdWorkerService,
    workerService,
} from '../../src/workers/service.js';

const directories: string[] = [];

afterEach(async () => {
    for (const directory of directories.splice(0))
        await rm(directory, { recursive: true, force: true });
});

async function recorder() {
    const directory = await mkdtemp(join(tmpdir(), 'workbench-worker-service-'));
    directories.push(directory);
    const commands: Array<{ command: string[]; runtime?: string }> = [];
    return {
        directory,
        commands,
        run: async (command: string[], env?: Record<string, string | undefined>) => {
            commands.push({
                command,
                ...(env?.XDG_RUNTIME_DIR ? { runtime: env.XDG_RUNTIME_DIR } : {}),
            });
            if (command[1] === 'print')
                return { code: 0, stdout: 'state = running\n', stderr: '' };
            if (command.includes('is-active'))
                return { code: 0, stdout: 'active\n', stderr: '' };
            return { code: 0, stdout: '', stderr: '' };
        },
    };
}

const spec = {
    command: [
        '/opt/wb/bin/wb',
        '__worker-daemon',
        '/home/ada/My Home/.workbench',
        '--api-url',
        'https://api.workbenches.dev',
    ],
    environment: { PATH: '/usr/local/bin:/usr/bin:/bin' },
    outputPath: '/home/ada/.workbench/worker/daemon.out',
};

describe('worker service', () => {
    test('installs a systemd user service with lingering on Linux', async () => {
        const { directory, commands, run } = await recorder();
        const service = new SystemdWorkerService({
            run,
            userHome: directory,
            uid: 1000,
            user: 'ada',
            environment: {},
        });
        await service.install(spec);
        const unit = await readFile(service.path, 'utf8');
        expect(service.path).toBe(
            join(directory, '.config', 'systemd', 'user', 'workbench-worker.service')
        );
        expect(unit).toContain(
            'ExecStart="/opt/wb/bin/wb" "__worker-daemon" "/home/ada/My Home/.workbench" "--api-url" "https://api.workbenches.dev"'
        );
        expect(unit).toContain('Environment="PATH=/usr/local/bin:/usr/bin:/bin"');
        expect(unit).toContain('KillMode=process');
        expect(unit).toContain('Restart=on-failure');
        expect(unit).toContain('WantedBy=default.target');
        expect(commands).toEqual([
            {
                command: ['loginctl', 'enable-linger', 'ada'],
                runtime: '/run/user/1000',
            },
            {
                command: ['systemctl', '--user', 'daemon-reload'],
                runtime: '/run/user/1000',
            },
            {
                command: ['systemctl', '--user', 'enable', 'workbench-worker.service'],
                runtime: '/run/user/1000',
            },
            {
                command: ['systemctl', '--user', 'restart', 'workbench-worker.service'],
                runtime: '/run/user/1000',
            },
        ]);
        expect(await service.running()).toBe(true);
        commands.length = 0;
        await service.uninstall();
        expect(commands.map((entry) => entry.command)).toEqual([
            ['systemctl', '--user', 'disable', '--now', 'workbench-worker.service'],
            ['systemctl', '--user', 'daemon-reload'],
        ]);
        expect(await Bun.file(service.path).exists()).toBe(false);
    });

    test('explains how to enable lingering when it is not allowed', async () => {
        const { directory } = await recorder();
        const service = new SystemdWorkerService({
            run: async (command) =>
                command[0] === 'loginctl'
                    ? { code: 1, stdout: '', stderr: 'Access denied' }
                    : { code: 0, stdout: '', stderr: '' },
            userHome: directory,
            uid: 1000,
            user: 'ada',
            environment: {},
        });
        expect(await service.install(spec).catch((error: Error) => error.message)).toBe(
            'Could not enable lingering for ada. Run sudo loginctl enable-linger ada and try again: Access denied'
        );
    });

    test('installs a launchd agent in the user background domain on macOS', async () => {
        const { directory, commands, run } = await recorder();
        const service = new LaunchdWorkerService({
            run,
            userHome: directory,
            uid: 501,
            user: 'ada',
        });
        await service.install({ ...spec, command: [...spec.command, 'a&b'] });
        const plist = await readFile(service.path, 'utf8');
        expect(service.path).toBe(
            join(directory, 'Library', 'LaunchAgents', 'dev.workbenches.worker.plist')
        );
        expect(plist).toContain('<string>/home/ada/My Home/.workbench</string>');
        expect(plist).toContain('<string>a&amp;b</string>');
        expect(plist).toContain(
            '<key>LimitLoadToSessionType</key><string>Background</string>'
        );
        expect(plist).toContain('<key>AbandonProcessGroup</key><true/>');
        expect(plist).toContain(
            '<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>'
        );
        expect(commands.map((entry) => entry.command)).toEqual([
            ['launchctl', 'bootout', 'user/501/dev.workbenches.worker'],
            ['launchctl', 'enable', 'user/501/dev.workbenches.worker'],
            ['launchctl', 'bootstrap', 'user/501', service.path],
            ['launchctl', 'kickstart', 'user/501/dev.workbenches.worker'],
        ]);
        expect(await service.running()).toBe(true);
    });

    test('retries a launchd bootstrap once after an input/output error', async () => {
        const { directory } = await recorder();
        const commands: string[] = [];
        const waits: number[] = [];
        let bootstraps = 0;
        const service = new LaunchdWorkerService({
            run: async (command) => {
                commands.push(command[1] ?? '');
                if (command[1] === 'bootstrap' && bootstraps++ === 0)
                    return {
                        code: 5,
                        stdout: '',
                        stderr: 'Bootstrap failed: 5: Input/output error\n',
                    };
                return { code: 0, stdout: '', stderr: '' };
            },
            wait: async (milliseconds) => {
                waits.push(milliseconds);
            },
            userHome: directory,
            uid: 501,
            user: 'ada',
        });
        await service.install(spec);
        expect(commands).toEqual([
            'bootout',
            'enable',
            'bootstrap',
            'bootstrap',
            'kickstart',
        ]);
        expect(waits).toEqual([1000]);
    });

    test('reports a launchd bootstrap that keeps failing', async () => {
        const { directory } = await recorder();
        const commands: string[] = [];
        const service = new LaunchdWorkerService({
            run: async (command) => {
                commands.push(command[1] ?? '');
                return command[1] === 'bootstrap'
                    ? {
                          code: 5,
                          stdout: '',
                          stderr: 'Bootstrap failed: 5: Input/output error\n',
                      }
                    : { code: 0, stdout: '', stderr: '' };
            },
            wait: async () => {},
            userHome: directory,
            uid: 501,
            user: 'ada',
        });
        expect(await service.install(spec).catch((error: Error) => error.message)).toBe(
            'launchd could not load the worker service: Bootstrap failed: 5: Input/output error'
        );
        expect(commands).toEqual(['bootout', 'enable', 'bootstrap', 'bootstrap']);
    });

    test('is not supported on Windows yet', () => {
        expect(() => workerService('win32')).toThrow(
            'wb worker is not supported on Windows yet. Use macOS or Linux'
        );
        expect(workerService('linux').kind).toBe('systemd');
        expect(workerService('darwin').kind).toBe('launchd');
    });
});
