import type { OutcomeWarning } from '../../outcomes/contracts.js';
import type { TransferRules } from './rules.js';
import { quote } from './shell.js';

export interface WorkspaceCollectionPaths {
    archive: string;
    changed: string;
    deleted: string;
}

/**
 * Sandbox commands and messages shared by every remote outcome collector. The
 * commands list a workspace's changes against the Git baseline taken at staging
 * and pack them, so only changed files cross the network. `rules` names the
 * provider in messages.
 */
export class CollectionCommands {
    constructor(private readonly rules: TransferRules) {}

    workspacePaths(index: number): WorkspaceCollectionPaths {
        return {
            archive: `/tmp/workbench-output-${index}.tar.gz`,
            changed: `/tmp/workbench-changed-${index}`,
            deleted: `/tmp/workbench-deleted-${index}`,
        };
    }

    workspace(options: {
        git: string;
        root: string;
        baseline: string;
        paths: WorkspaceCollectionPaths;
    }): string {
        const { git, root, baseline, paths } = options;
        return [
            `${git} add -A`,
            // Without rename detection a moved file is its old path deleted and its new path added.
            `${git} diff --cached --no-renames --name-only --diff-filter=ACMRTUXB -z ${quote(baseline)} > ${quote(paths.changed)}`,
            `${git} diff --cached --no-renames --name-only --diff-filter=D -z ${quote(baseline)} > ${quote(paths.deleted)}`,
            `tar -C ${quote(root)} --null --files-from=${quote(paths.changed)} -czf ${quote(paths.archive)}`,
        ].join(' && ');
    }

    output(options: { root: string; files: string; archive: string }): string {
        const { root, files, archive } = options;
        return [
            `(cd ${quote(root)} && find . -mindepth 1 -print0) > ${quote(files)}`,
            `tar -C ${quote(root)} --no-recursion --null --files-from=${quote(files)} -czf ${quote(archive)}`,
        ].join(' && ');
    }

    warnings(paths: string[]): OutcomeWarning[] {
        if (paths.length === 0) return [];
        const visible = paths
            .slice(0, 3)
            .map((path) => JSON.stringify(path))
            .join(', ');
        const remaining = paths.length - 3;
        return [
            {
                code: 'workspace_paths_excluded',
                message: `${paths.length} protected or nested workspace path${paths.length === 1 ? ' was' : 's were'} not sent to ${this.rules.provider}: ${visible}${remaining > 0 ? `, and ${remaining} more` : ''}. ${paths.length === 1 ? 'This path' : 'These paths'} cannot appear in returned changes.`,
            },
        ];
    }

    requireSuccess(
        result: { code: number; stdout: string; stderr: string },
        message: string
    ): void {
        if (result.code === 0) return;
        const detail = result.stderr.trim() || result.stdout.trim();
        throw new Error(`${message}${detail ? `: ${detail}` : ''}`);
    }
}
