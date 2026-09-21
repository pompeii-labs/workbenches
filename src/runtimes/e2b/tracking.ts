import { quote } from './shell.js';
import type { E2BAssetSnapshot } from './snapshot.js';

export const remoteExclusions = [
    '.env',
    '.env.*',
    '!.env.example',
    '!.env.sample',
    '.ssh',
    '.aws',
    '.gnupg',
    'node_modules',
    '.npmrc',
    '.netrc',
    '.pypirc',
    'id_rsa',
    'id_ed25519',
    'credentials',
    '*.pem',
    '*.key',
    '*.p12',
    '*.pfx',
    '*.kubeconfig',
];

/** Keep collection's writable index separate from a staged read-only repository. */
export function workspaceTracking(
    snapshots: E2BAssetSnapshot[],
    index: number
): { git: string; directory: string } {
    const root = snapshots[index]?.binding.runtimePath;
    if (!root) throw new Error('E2B workspace snapshot is unavailable');
    const staged = snapshots.some(
        (snapshot) =>
            snapshot.binding.kind === 'git' &&
            snapshot.binding.runtimePath === `${root}/.git`
    );
    const directory = staged ? `/tmp/workbench-index-${index}.git` : `${root}/.git`;
    return {
        directory,
        git: `git -C ${quote(root)}${staged ? ` --git-dir=${quote(directory)} --work-tree=${quote(root)}` : ''}`,
    };
}
