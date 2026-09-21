import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nativeCredentialPaths } from '../../connections/index.js';
import type { E2BSandbox } from './contracts.js';
import { quote } from './shell.js';
import type { E2BAssetSnapshot } from './snapshot.js';
import { downloadE2BFile } from './streams.js';

export async function captureE2BNativeState(
    sandbox: E2BSandbox,
    snapshots: E2BAssetSnapshot[],
    maximumBytes: number,
    completed = new Set<number>(),
    checkpoint?: (completed: Set<number>) => Promise<void>
): Promise<void> {
    const directory = await mkdtemp(join(tmpdir(), 'workbench-e2b-state-'));
    let transferred = 0;
    let materialized = 0;
    try {
        for (const [index, snapshot] of snapshots.entries()) {
            if (
                snapshot.binding.kind !== 'state' &&
                snapshot.binding.kind !== 'credentials' &&
                snapshot.binding.kind !== 'git'
            )
                continue;
            if (completed.has(index)) continue;
            const root = snapshot.binding.runtimePath;
            const remoteArchive = `/tmp/workbench-native-state-${index}.tar.gz`;
            const selection =
                snapshot.binding.kind === 'credentials'
                    ? `cd ${quote(root)}; set --; for file in ${nativeCredentialPaths.map(quote).join(' ')}; do if [ -e "$file" ] || [ -L "$file" ]; then set -- "$@" "$file"; fi; done; tar -czf ${quote(remoteArchive)} -T /dev/null "$@"`
                    : `tar -C ${quote(root)} --exclude=./.git --exclude=./.workbench-state -czf ${quote(remoteArchive)} .`;
            const result = await sandbox.run(selection);
            if (result.code !== 0)
                throw new Error(
                    `Failed to collect E2B native state: ${result.stderr.trim()}`
                );
            const archive = join(directory, `${index}.tar.gz`);
            transferred += await downloadE2BFile(
                sandbox,
                remoteArchive,
                archive,
                maximumBytes - transferred,
                maximumBytes
            );
            materialized += await snapshot.persistState(
                archive,
                maximumBytes - materialized
            );
            completed.add(index);
            await checkpoint?.(completed);
            await sandbox.run(`rm -f ${quote(remoteArchive)}`).catch(() => {});
        }
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}
