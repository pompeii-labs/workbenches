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
    rootMessage: string | undefined;

    async run(
        command: string,
        options: { user?: 'root' } = {}
    ): Promise<RuntimeCommandResult> {
        this.runs.push({ command, user: options.user });
        if (command === identityCommand) return result(0, '1000:1000');
        return this.rootMessage ? result(1, '', this.rootMessage) : result(0);
    }
}

function result(code: number, stdout = '', stderr = ''): RuntimeCommandResult {
    return { code, stdout, stderr };
}

describe('StagingDirectories', () => {
    test('creates each directory once as root and hands it to the sandbox user', async () => {
        const sandbox = new FakeSandbox();
        await new StagingDirectories(sandbox, new TransferRules('Remote')).prepare([
            '/workspace',
            '/workspace',
        ]);
        const root = sandbox.runs.find((run) => run.user === 'root');
        expect(root?.command).toContain("chown '1000:1000' '/workspace'");
        expect(root?.command).toContain("test ! -L '/workspace'");
        expect(root?.command.match(/mkdir -p '\/workspace'/g)).toHaveLength(1);
    });

    test('names the provider and the failure when provisioning fails', async () => {
        const sandbox = new FakeSandbox();
        sandbox.rootMessage = 'denied';
        await expect(
            new StagingDirectories(sandbox, new TransferRules('Remote')).prepare([
                '/workspace',
            ])
        ).rejects.toThrow('Failed to provision Remote staging directories: denied');
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
