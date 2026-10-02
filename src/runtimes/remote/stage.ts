import { dirname } from 'node:path';

import type { TransferRules } from '../staging/rules.js';
import { gitExcludePattern, quote } from '../staging/shell.js';
import { remoteExclusions, workspaceTracking } from '../staging/tracking.js';
import type { StagedAsset } from '../staging/transfer.js';
import { type DirectorySandbox, StagingDirectories } from './directories.js';

/** Puts one staged archive into the sandbox. */
export interface ArchiveUpload<S extends StagedAsset> {
    upload(remotePath: string, asset: S): Promise<void>;
}

/** The directory the sandbox uses for runner state. */
const defaultHome = '/tmp/workbench-home';

/**
 * Copies each staged archive into a sandbox and unpacks it at its runtime
 * path. Read-write workspaces get a synthetic Git baseline, recorded by
 * snapshot index, so their changes can be collected later. Read-only assets
 * lose their write bits. `rules` names the provider in messages.
 */
export class AssetStage<S extends StagedAsset> {
    constructor(
        private readonly sandbox: DirectorySandbox,
        private readonly uploads: ArchiveUpload<S>,
        private readonly rules: TransferRules
    ) {}

    /** Stages `assets` and returns each tracked workspace's baseline by index. */
    async stage(assets: S[], home = defaultHome): Promise<Map<number, string>> {
        const provider = this.rules.provider;
        await new StagingDirectories(this.sandbox, this.rules).prepare([
            home,
            ...assets.map((asset) =>
                asset.sourceIsDirectory
                    ? asset.binding.runtimePath
                    : dirname(asset.binding.runtimePath)
            ),
        ]);
        const baselines = new Map<number, string>();
        for (const [index, asset] of assets.entries()) {
            const remoteArchive = `/tmp/workbench-input-${index}.tar.gz`;
            await this.uploads.upload(remoteArchive, asset);
            const target = asset.binding.runtimePath;
            const command = asset.sourceIsDirectory
                ? [
                      `mkdir -p ${quote(target)}`,
                      `tar -xzf ${quote(remoteArchive)} -C ${quote(target)}`,
                      ...(asset.binding.kind === 'git'
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
            const tracked = this.tracked(asset);
            if (tracked) {
                const tracking = workspaceTracking(assets, index);
                command.push(
                    `${tracking.git} init -q`,
                    `${tracking.git} config user.email workbench@localhost`,
                    `${tracking.git} config user.name Workbench`,
                    `printf '%s\\n' ${[
                        ...remoteExclusions,
                        ...asset.syncExcludedPaths.map(gitExcludePattern),
                    ]
                        .map(quote)
                        .join(' ')} >> ${quote(`${tracking.directory}/info/exclude`)}`,
                    `${tracking.git} add -A`,
                    `${tracking.git} commit -q --allow-empty --no-gpg-sign -m baseline`,
                    `${tracking.git} rev-parse HEAD`
                );
            } else if (asset.binding.access === 'read-only') {
                command.push(`chmod -R a-w ${quote(target)}`);
            }
            command.push(`rm -f ${quote(remoteArchive)}`);
            const result = await this.sandbox.run(command.join(' && '));
            if (result.code !== 0) {
                const detail = result.stderr.trim() || result.stdout.trim();
                throw new Error(
                    `Failed to stage ${provider} runtime asset: ${asset.binding.hostPath}${detail ? `: ${detail}` : ''}`
                );
            }
            if (tracked) {
                const baseline = result.stdout.trim().split(/\s+/).at(-1) ?? '';
                if (!/^[a-f0-9]{40,64}$/.test(baseline)) {
                    throw new Error(
                        `Failed to record the ${provider} workspace baseline: ${asset.binding.hostPath}`
                    );
                }
                baselines.set(index, baseline);
            }
        }
        return baselines;
    }

    /**
     * Recovers each tracked workspace's Git baseline from a sandbox that already
     * holds the staged files: staging committed it first, so the root commit is
     * it. Keys are snapshot indexes.
     */
    async recover(assets: S[]): Promise<Map<number, string>> {
        const baselines = new Map<number, string>();
        for (const [index, asset] of assets.entries()) {
            if (!this.tracked(asset)) continue;
            const tracking = workspaceTracking(assets, index);
            const result = await this.sandbox.run(
                `${tracking.git} rev-list --max-parents=0 HEAD`
            );
            const baseline = result.stdout.trim().split(/\s+/).at(-1) ?? '';
            if (result.code !== 0 || !/^[a-f0-9]{40,64}$/.test(baseline)) {
                throw new Error(
                    `Cannot find the workspace baseline in the ${this.rules.provider} sandbox: ${asset.binding.hostPath}`
                );
            }
            baselines.set(index, baseline);
        }
        return baselines;
    }

    private tracked(asset: StagedAsset): boolean {
        return (
            asset.binding.access === 'read-write' &&
            asset.sourceIsDirectory &&
            asset.binding.kind !== 'outcome' &&
            asset.binding.kind !== 'git'
        );
    }
}
