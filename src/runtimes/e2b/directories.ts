import { posix } from 'node:path';
import type { E2BSandbox } from './contracts.js';
import { quote } from './shell.js';

export const e2bIdentityCommand = 'printf "%s:%s" "$(id -u)" "$(id -g)"';

export async function prepareE2BDirectories(
    sandbox: E2BSandbox,
    directories: string[]
): Promise<void> {
    const targets = [...new Set(directories)];
    for (const target of targets) {
        if (
            !target.startsWith('/') ||
            target === '/' ||
            posix.normalize(target) !== target ||
            target.includes('\0')
        ) {
            throw new Error('Invalid E2B staging directory');
        }
    }
    const identity = await sandbox.run(e2bIdentityCommand);
    requireSuccess(identity, 'Failed to determine the E2B runtime user');
    const owner = identity.stdout.trim();
    if (!/^\d{1,10}:\d{1,10}$/.test(owner)) {
        throw new Error('Invalid E2B runtime user identity');
    }
    const ancestors = new Set<string>();
    for (const target of targets) {
        for (let path = target; path !== '/'; path = posix.dirname(path)) {
            ancestors.add(path);
        }
    }
    // Only directory provisioning uses root. Extraction and harness processes
    // retain the template's default user and cannot select this setup option.
    const provisioned = await sandbox.run(
        [
            ...[...ancestors].map((path) => `test ! -L ${quote(path)}`),
            ...targets.flatMap((path) => [
                `mkdir -p ${quote(path)}`,
                `chown ${quote(owner)} ${quote(path)}`,
                `chmod 700 ${quote(path)}`,
            ]),
        ].join(' && '),
        { user: 'root' }
    );
    requireSuccess(provisioned, 'Failed to provision E2B staging directories');
}

function requireSuccess(
    result: { code: number; stdout: string; stderr: string },
    message: string
): void {
    if (result.code === 0) return;
    const detail = result.stderr.trim() || result.stdout.trim();
    throw new Error(`${message}${detail ? `: ${detail}` : ''}`);
}
