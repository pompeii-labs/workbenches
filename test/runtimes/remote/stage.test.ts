import { describe, expect, test } from 'bun:test';

import type { RuntimeCommandResult } from '../../../src/runtimes/contracts.js';
import {
    type DirectorySandbox,
    identityCommand,
} from '../../../src/runtimes/remote/directories.js';
import { type ArchiveUpload, AssetStage } from '../../../src/runtimes/remote/stage.js';
import { TransferRules } from '../../../src/runtimes/staging/rules.js';
import type {
    AssetBinding,
    StagedAsset,
} from '../../../src/runtimes/staging/transfer.js';

const baseline = 'a'.repeat(40);

class FakeSandbox implements DirectorySandbox {
    readonly commands: string[] = [];
    stageFailure: string | undefined;
    revision = baseline;

    async run(command: string): Promise<RuntimeCommandResult> {
        if (command === identityCommand) return result(0, '1000:1000');
        if (command.includes('rev-parse HEAD') && !command.includes('mkdir -p /')) {
            this.commands.push(command);
            return this.stageFailure
                ? result(1, '', this.stageFailure)
                : result(0, `${this.revision}\n`);
        }
        if (command.startsWith('mkdir -p')) {
            this.commands.push(command);
            return this.stageFailure ? result(1, '', this.stageFailure) : result(0);
        }
        return result(0);
    }
}

class FakeUpload implements ArchiveUpload<FakeAsset> {
    readonly uploads: Array<{ path: string; asset: FakeAsset }> = [];
    async upload(path: string, asset: FakeAsset) {
        this.uploads.push({ path, asset });
    }
}

class FakeAsset implements StagedAsset {
    readonly bytes = 1;
    readonly excludedPaths: string[] = [];
    readonly syncExcludedPaths: string[] = [];
    readonly binding: AssetBinding;

    constructor(
        runtimePath: string,
        access: 'read-only' | 'read-write',
        readonly sourceIsDirectory = true,
        kind: AssetBinding['kind'] = 'workspace'
    ) {
        this.binding = {
            hostPath: `/host${runtimePath}`,
            runtimePath,
            access,
            excludedHostPaths: [],
            kind,
        };
    }
    async archiveBytes() {
        return new Uint8Array();
    }
    async cleanup() {}
}

function result(code: number, stdout = '', stderr = ''): RuntimeCommandResult {
    return { code, stdout, stderr };
}

describe('AssetStage', () => {
    test('uploads each archive, baselines workspaces, and locks read-only assets', async () => {
        const sandbox = new FakeSandbox();
        const uploads = new FakeUpload();
        const workspace = new FakeAsset('/workspace', 'read-write');
        const package_ = new FakeAsset('/workbench', 'read-only', true, 'package');
        const baselines = await new AssetStage(
            sandbox,
            uploads,
            new TransferRules('Remote')
        ).stage([workspace, package_]);
        expect(uploads.uploads.map((upload) => upload.path)).toEqual([
            '/tmp/workbench-input-0.tar.gz',
            '/tmp/workbench-input-1.tar.gz',
        ]);
        expect([...baselines]).toEqual([[0, baseline]]);
        const [stagedWorkspace, stagedPackage] = sandbox.commands.slice(-2);
        expect(stagedWorkspace).toContain('commit -q --allow-empty');
        expect(stagedPackage).toContain("chmod -R a-w '/workbench'");
        expect(stagedPackage).not.toContain('commit');
    });

    test('names the provider when staging fails', async () => {
        const sandbox = new FakeSandbox();
        sandbox.stageFailure = 'disk full';
        await expect(
            new AssetStage(
                sandbox,
                new FakeUpload(),
                new TransferRules('Remote')
            ).stage([new FakeAsset('/workspace', 'read-write')])
        ).rejects.toThrow(
            'Failed to stage Remote runtime asset: /host/workspace: disk full'
        );
    });

    test('rejects a baseline that is not a commit id', async () => {
        const sandbox = new FakeSandbox();
        sandbox.revision = 'not-a-revision';
        await expect(
            new AssetStage(
                sandbox,
                new FakeUpload(),
                new TransferRules('Remote')
            ).stage([new FakeAsset('/workspace', 'read-write')])
        ).rejects.toThrow(
            'Failed to record the Remote workspace baseline: /host/workspace'
        );
    });
});
