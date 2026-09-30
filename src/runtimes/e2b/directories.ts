import { posix } from 'node:path';
import type { E2BSandbox } from './contracts.js';
import { quote } from './shell.js';

export const e2bIdentityCommand = 'printf "%s:%s" "$(id -u)" "$(id -g)"';

export async function prepareE2BDirectories(
    sandbox: Pick<E2BSandbox, 'run'>,
    directories: string[],
    label = 'E2B'
): Promise<void> {
    const targets = [...new Set(directories)];
    for (const target of targets) {
        if (
            !target.startsWith('/') ||
            target === '/' ||
            posix.normalize(target) !== target ||
            target.includes('\0')
        ) {
            throw new Error(`Invalid ${label} staging directory`);
        }
    }
    const identity = await sandbox.run(e2bIdentityCommand);
    requireSuccess(identity, `Failed to determine the ${label} runtime user`);
    const owner = identity.stdout.trim();
    if (!/^\d{1,10}:\d{1,10}$/.test(owner)) {
        throw new Error(`Invalid ${label} runtime user identity`);
    }
    const ancestors = new Set<string>();
    for (const target of targets) {
        for (let path = target; path !== '/'; path = posix.dirname(path)) {
            ancestors.add(path);
        }
    }
    const symlinkGuards = [...ancestors].map((path) => `test ! -L ${quote(path)}`);
    // Images that run as a non-root user without sudo pre-create the directories.
    // When every target already exists and belongs to the sandbox user, no root
    // access is needed.
    const owned = await sandbox.run(
        [
            ...symlinkGuards,
            ...targets.map(
                (path) => `test -d ${quote(path)} && test -O ${quote(path)}`
            ),
        ].join(' && ')
    );
    if (owned.code === 0) {
        const restricted = await sandbox.run(
            targets.map((path) => `chmod 700 ${quote(path)}`).join(' && ')
        );
        requireSuccess(restricted, `Failed to secure ${label} staging directories`);
        return;
    }
    // Only directory provisioning uses root. Extraction and harness processes
    // retain the template's default user and cannot select this setup option.
    const provisioned = await sandbox.run(
        [
            ...symlinkGuards,
            ...targets.flatMap((path) => [
                `mkdir -p ${quote(path)}`,
                `chown ${quote(owner)} ${quote(path)}`,
                `chmod 700 ${quote(path)}`,
            ]),
        ].join(' && '),
        { user: 'root' }
    );
    if (
        provisioned.code !== 0 &&
        /root access is required/i.test(provisioned.stderr + provisioned.stdout)
    ) {
        let offending = targets[0] as string;
        for (const target of targets) {
            const check = await sandbox.run(
                `test -d ${quote(target)} && test -O ${quote(target)}`
            );
            if (check.code !== 0) {
                offending = target;
                break;
            }
        }
        throw new Error(
            `Failed to provision ${label} staging directory ${offending}: the sandbox image must run as root, allow sudo, or pre-create that directory owned by the sandbox user`
        );
    }
    requireSuccess(provisioned, `Failed to provision ${label} staging directories`);
}

function requireSuccess(
    result: { code: number; stdout: string; stderr: string },
    message: string
): void {
    if (result.code === 0) return;
    const detail = result.stderr.trim() || result.stdout.trim();
    throw new Error(`${message}${detail ? `: ${detail}` : ''}`);
}
