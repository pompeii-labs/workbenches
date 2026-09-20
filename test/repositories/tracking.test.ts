import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { quote } from '../../src/runtimes/e2b/shell.js';
import type { E2BAssetSnapshot } from '../../src/runtimes/e2b/snapshot.js';
import { workspaceTracking } from '../../src/runtimes/e2b/tracking.js';
import { checkoutFixture, temporary } from './fixture.js';

describe('E2B repository collection index', () => {
    test('stages binary changes without writing the agent-visible repository index', async () => {
        const fixture = await checkoutFixture();
        const root = fixture.source;
        const snapshots = [
            { binding: { runtimePath: root, kind: 'workspace', access: 'read-write' } },
            {
                binding: {
                    runtimePath: join(root, '.git'),
                    kind: 'git',
                    access: 'read-write',
                },
            },
        ] as E2BAssetSnapshot[];
        const tracking = workspaceTracking(snapshots, 0);
        expect(tracking.directory).toBe('/tmp/workbench-index-0.git');
        const privateDirectory = join(await temporary(), 'tracking.git');
        const git = tracking.git.replace(
            quote(tracking.directory),
            quote(privateDirectory)
        );
        const execute = async (args: string) => {
            const child = Bun.spawn(['sh', '-c', `${git} ${args}`], {
                stdin: 'ignore',
                stdout: 'pipe',
                stderr: 'pipe',
            });
            const [code, output, error] = await Promise.all([
                child.exited,
                new Response(child.stdout).text(),
                new Response(child.stderr).text(),
            ]);
            if (code) throw new Error(error);
            return output.trim();
        };
        const before = await readFile(join(root, '.git', 'index'));
        await execute('init -q');
        await execute('config user.name Workbench');
        await execute('config user.email workbench@localhost');
        await execute('add -A');
        await execute('commit -q --allow-empty --no-gpg-sign -m baseline');
        const baseline = await execute('rev-parse HEAD');
        await writeFile(join(root, 'binary.bin'), Buffer.from([0, 255, 128, 7, 10]));
        await execute('add -A');
        expect(await execute(`diff --cached --name-only ${baseline}`)).toBe(
            'binary.bin'
        );
        expect(await execute('rev-parse :binary.bin')).toBe(
            createHash('sha1')
                .update('blob 5\0')
                .update(Buffer.from([0, 255, 128, 7, 10]))
                .digest('hex')
        );
        expect(await readFile(join(root, '.git', 'index'))).toEqual(before);
        expect(await readFile(join(root, 'binary.bin'))).toEqual(
            Buffer.from([0, 255, 128, 7, 10])
        );
    });
});
