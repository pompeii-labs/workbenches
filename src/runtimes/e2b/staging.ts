import { dirname } from 'node:path';

import type { E2BSandbox } from './contracts.js';
import { prepareE2BDirectories } from './directories.js';
import { gitExcludePattern, quote } from './shell.js';
import type { E2BAssetSnapshot } from './snapshot.js';
import { remoteExclusions, workspaceTracking } from './tracking.js';

export interface SnapshotUpload {
    /** Writes `snapshot`'s archive to `remotePath` inside the sandbox. */
    upload(remotePath: string, snapshot: E2BAssetSnapshot): Promise<void>;
}

/**
 * Copies each snapshot archive into the sandbox and unpacks it at its runtime
 * path. Read-write workspaces get a synthetic Git baseline, recorded in
 * `baselines` by snapshot index, so changes can be collected later. Read-only
 * assets lose their write bits. Remote providers share this.
 */
export async function stageSnapshots(options: {
    sandbox: Pick<E2BSandbox, 'run'>;
    uploader: SnapshotUpload;
    snapshots: E2BAssetSnapshot[];
    home: string;
    baselines: Map<number, string>;
    /** Provider name used in messages. Defaults to `E2B`. */
    label?: string;
}): Promise<void> {
    const { sandbox, snapshots, baselines, uploader } = options;
    const label = options.label ?? 'E2B';
    await prepareE2BDirectories(
        sandbox,
        [
            options.home,
            ...snapshots.map((snapshot) =>
                snapshot.sourceIsDirectory
                    ? snapshot.binding.runtimePath
                    : dirname(snapshot.binding.runtimePath)
            ),
        ],
        label
    );
    for (const [index, snapshot] of snapshots.entries()) {
        const remoteArchive = `/tmp/workbench-input-${index}.tar.gz`;
        await uploader.upload(remoteArchive, snapshot);
        const target = snapshot.binding.runtimePath;
        const command = snapshot.sourceIsDirectory
            ? [
                  `mkdir -p ${quote(target)}`,
                  `tar -xzf ${quote(remoteArchive)} -C ${quote(target)}`,
                  ...(snapshot.binding.kind === 'git'
                      ? [
                            `mkdir -p ${quote(`${target}/refs/heads`)} ${quote(`${target}/refs/tags`)} ${quote(`${target}/info`)}`,
                        ]
                      : []),
              ]
            : [
                  `mkdir -p ${quote(dirname(target))}`,
                  `rm -f ${quote(target)}`,
                  `tar -xzf ${quote(remoteArchive)} -C /tmp`,
                  `mv /tmp/.workbench-file ${quote(target)}`,
              ];
        const tracked =
            snapshot.binding.access === 'read-write' &&
            snapshot.sourceIsDirectory &&
            snapshot.binding.kind !== 'outcome' &&
            snapshot.binding.kind !== 'git';
        if (tracked) {
            const tracking = workspaceTracking(snapshots, index);
            command.push(
                `${tracking.git} init -q`,
                `${tracking.git} config user.email workbench@localhost`,
                `${tracking.git} config user.name Workbench`,
                `printf '%s\\n' ${[
                    ...remoteExclusions,
                    ...snapshot.syncExcludedPaths.map(gitExcludePattern),
                ]
                    .map(quote)
                    .join(' ')} >> ${quote(`${tracking.directory}/info/exclude`)}`,
                `${tracking.git} add -A`,
                `${tracking.git} commit -q --allow-empty --no-gpg-sign -m baseline`,
                `${tracking.git} rev-parse HEAD`
            );
        } else if (snapshot.binding.access === 'read-only') {
            command.push(`chmod -R a-w ${quote(target)}`);
        }
        command.push(`rm -f ${quote(remoteArchive)}`);
        const result = await sandbox.run(command.join(' && '));
        if (result.code !== 0) {
            const detail = result.stderr.trim() || result.stdout.trim();
            throw new Error(
                `Failed to stage ${label} runtime asset: ${snapshot.binding.hostPath}${detail ? `: ${detail}` : ''}`
            );
        }
        if (tracked) {
            const baseline = result.stdout.trim().split(/\s+/).at(-1) ?? '';
            if (!/^[a-f0-9]{40,64}$/.test(baseline)) {
                throw new Error(
                    `Failed to record the ${label} workspace baseline: ${snapshot.binding.hostPath}`
                );
            }
            baselines.set(index, baseline);
        }
    }
}
