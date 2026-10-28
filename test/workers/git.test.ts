import { describe, expect, test } from 'bun:test';

import { WorkerGit } from '../../src/workers/git.js';

function git(options: {
    platform: string;
    path: string | null;
    codes?: Record<string, number>;
}) {
    const commands: string[][] = [];
    const probe = new WorkerGit({
        platform: options.platform,
        findExecutable: () => options.path,
        run: async (command) => {
            commands.push(command);
            return options.codes?.[command[0] ?? ''] ?? 0;
        },
    });
    return { probe, commands };
}

describe('worker git', () => {
    test('is usable when git --version succeeds', async () => {
        const { probe, commands } = git({ platform: 'linux', path: '/usr/bin/git' });
        expect(await probe.usable()).toBe(true);
        expect(commands).toEqual([['/usr/bin/git', '--version']]);
    });

    test('is not usable when git is missing or fails', async () => {
        expect(await git({ platform: 'linux', path: null }).probe.usable()).toBe(false);
        expect(
            await git({
                platform: 'linux',
                path: '/usr/bin/git',
                codes: { '/usr/bin/git': 1 },
            }).probe.usable()
        ).toBe(false);
    });

    test('never runs the macOS stub when the developer tools are missing', async () => {
        const { probe, commands } = git({
            platform: 'darwin',
            path: '/usr/bin/git',
            codes: { 'xcode-select': 2 },
        });
        expect(await probe.usable()).toBe(false);
        expect(commands).toEqual([['xcode-select', '-p']]);
    });

    test('runs the macOS stub once the developer tools are installed', async () => {
        const { probe, commands } = git({ platform: 'darwin', path: '/usr/bin/git' });
        expect(await probe.usable()).toBe(true);
        expect(commands).toEqual([
            ['xcode-select', '-p'],
            ['/usr/bin/git', '--version'],
        ]);
    });

    test('runs a git from elsewhere on macOS without asking xcode-select', async () => {
        const { probe, commands } = git({
            platform: 'darwin',
            path: '/opt/homebrew/bin/git',
            codes: { 'xcode-select': 2 },
        });
        expect(await probe.usable()).toBe(true);
        expect(commands).toEqual([['/opt/homebrew/bin/git', '--version']]);
    });
});
