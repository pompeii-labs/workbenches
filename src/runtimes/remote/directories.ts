import { posix } from 'node:path';

import type { RuntimeCommandResult } from '../contracts.js';
import type { TransferRules } from '../staging/rules.js';
import { quote } from '../staging/shell.js';

export const identityCommand = 'printf "%s:%s" "$(id -u)" "$(id -g)"';

/** The sandbox operation directory provisioning needs. */
export interface DirectorySandbox {
    run(command: string, options?: { user?: 'root' }): Promise<RuntimeCommandResult>;
}

/**
 * Creates the directories a remote sandbox stages files into, owned by the
 * sandbox user and private to it. `rules` names the provider in messages.
 */
export class StagingDirectories {
    constructor(
        private readonly sandbox: DirectorySandbox,
        private readonly rules: TransferRules
    ) {}

    async prepare(directories: string[]): Promise<void> {
        const provider = this.rules.provider;
        const targets = [...new Set(directories)];
        for (const target of targets) {
            if (
                !target.startsWith('/') ||
                target === '/' ||
                posix.normalize(target) !== target ||
                target.includes('\0')
            ) {
                throw new Error(`Invalid ${provider} staging directory`);
            }
        }
        const identity = await this.sandbox.run(identityCommand);
        this.require(identity, `Failed to determine the ${provider} runtime user`);
        const owner = identity.stdout.trim();
        if (!/^\d{1,10}:\d{1,10}$/.test(owner)) {
            throw new Error(`Invalid ${provider} runtime user identity`);
        }
        const ancestors = new Set<string>();
        for (const target of targets) {
            for (let path = target; path !== '/'; path = posix.dirname(path)) {
                ancestors.add(path);
            }
        }
        const symlinkGuards = [...ancestors].map((path) => `test ! -L ${quote(path)}`);
        // Try as the sandbox user first. Targets under writable parents such as /tmp,
        // or directories the image pre-created, need no root access.
        const asUser = await this.sandbox.run(
            [
                ...symlinkGuards,
                ...targets.map((path) => `mkdir -p ${quote(path)}`),
                ...targets.map(
                    (path) => `test -d ${quote(path)} && test -O ${quote(path)}`
                ),
                ...targets.map((path) => `chmod 700 ${quote(path)}`),
            ].join(' && ')
        );
        if (asUser.code === 0) return;
        // Only directory provisioning uses root. Extraction and harness processes
        // keep the image's default user and cannot select this setup option.
        const provisioned = await this.sandbox.run(
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
            throw new Error(
                `Failed to provision ${provider} staging directory ${await this.unowned(targets)}: the sandbox image must run as root, allow sudo, or pre-create that directory owned by the sandbox user`
            );
        }
        this.require(
            provisioned,
            `Failed to provision ${provider} staging directories`
        );
    }

    /** The first target the sandbox user does not own, or the first target. */
    private async unowned(targets: string[]): Promise<string> {
        for (const target of targets) {
            const check = await this.sandbox.run(
                `test -d ${quote(target)} && test -O ${quote(target)}`
            );
            if (check.code !== 0) return target;
        }
        return targets[0] as string;
    }

    private require(result: RuntimeCommandResult, message: string): void {
        if (result.code === 0) return;
        const detail = result.stderr.trim() || result.stdout.trim();
        throw new Error(`${message}${detail ? `: ${detail}` : ''}`);
    }
}
