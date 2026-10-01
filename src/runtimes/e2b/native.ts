import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nativeCredentialPaths } from '../../connections/index.js';
import { quote } from '../staging/shell.js';
import type { E2BSandbox } from './contracts.js';
import type { E2BAssetSnapshot } from './snapshot.js';
import { E2BTransfer } from './transfer.js';

/** Copies native state and credentials out of one E2B sandbox into their host stores. */
export class E2BNativeState {
    constructor(private readonly sandbox: Pick<E2BSandbox, 'run' | 'download'>) {}

    async capture(
        snapshots: E2BAssetSnapshot[],
        maximumBytes: number,
        completed = new Set<number>(),
        checkpoint?: (completed: Set<number>) => Promise<void>
    ): Promise<void> {
        const sandbox = this.sandbox;
        const transfer = new E2BTransfer(sandbox);
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
                transferred += await transfer.download(remoteArchive, archive, {
                    maximumBytes: maximumBytes - transferred,
                    reportedMaximumBytes: maximumBytes,
                });
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
}
