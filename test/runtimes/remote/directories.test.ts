import { describe, expect, test } from 'bun:test';

import type { RuntimeCommandResult } from '../../../src/runtimes/contracts.js';
import {
    type DirectorySandbox,
    identityCommand,
    StagingDirectories,
} from '../../../src/runtimes/remote/directories.js';
import { TransferRules } from '../../../src/runtimes/staging/rules.js';

class FakeSandbox implements DirectorySandbox {
    readonly runs: Array<{ command: string; user: 'root' | undefined }> = [];
    userCanCreate = true;
    rootMessage: string | undefined;

    async run(
        command: string,
        options: { user?: 'root' } = {}
    ): Promise<RuntimeCommandResult> {
        this.runs.push({ command, user: options.user });
        if (command === identityCommand) return result(0, '1000:1000');
        if (options.user === 'root') {
            return this.rootMessage ? result(1, '', this.rootMessage) : result(0);
        }
        if (command.includes('chmod 700') && !command.includes('chown')) {
            return this.userCanCreate ? result(0) : result(1, '', 'Permission denied');
        }
        return result(1);
    }
}

function result(code: number, stdout = '', stderr = ''): RuntimeCommandResult {
    return { code, stdout, stderr };
}

describe('StagingDirectories', () => {
    test('creates the directories as the sandbox user when it can', async () => {
        const sandbox = new FakeSandbox();
        await new StagingDirectories(sandbox, new TransferRules('Remote')).prepare([
            '/workspace',
            '/workspace',
            '/tmp/home',
        ]);
        expect(sandbox.runs.some((run) => run.user === 'root')).toBeFalse();
        expect(sandbox.runs[1]?.command).toContain("mkdir -p '/workspace'");
        expect(sandbox.runs[1]?.command.match(/mkdir -p '\/workspace'/g)).toHaveLength(
            1
        );
    });

    test('falls back to root and hands the directories to the sandbox user', async () => {
        const sandbox = new FakeSandbox();
        sandbox.userCanCreate = false;
        await new StagingDirectories(sandbox, new TransferRules('Remote')).prepare([
            '/workspace',
        ]);
        const root = sandbox.runs.find((run) => run.user === 'root');
        expect(root?.command).toContain("chown '1000:1000' '/workspace'");
        expect(root?.command).toContain("test ! -L '/workspace'");
    });

    test('names the directory and the provider when root is unavailable', async () => {
        const sandbox = new FakeSandbox();
        sandbox.userCanCreate = false;
        sandbox.rootMessage = 'root access is required';
        await expect(
            new StagingDirectories(sandbox, new TransferRules('Remote')).prepare([
                '/workspace',
            ])
        ).rejects.toThrow(
            'Failed to provision Remote staging directory /workspace: the sandbox image must run as root, allow sudo, or pre-create that directory owned by the sandbox user'
        );
    });

    test('rejects a directory that is not a normalized absolute path', async () => {
        const directories = new StagingDirectories(
            new FakeSandbox(),
            new TransferRules('Remote')
        );
        for (const path of ['/', 'workspace', '/a/../b', '/a//b']) {
            await expect(directories.prepare([path])).rejects.toThrow(
                'Invalid Remote staging directory'
            );
        }
    });
});
