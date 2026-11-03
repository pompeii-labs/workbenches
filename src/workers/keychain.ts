import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Runs `security -i` with `HOME` set, its commands on standard input. */
export type KeychainCommand = (
    home: string,
    input: string
) => Promise<{ code: number; stderr: string }>;

/**
 * A member directory's own macOS keychain. Claude Code on macOS keeps its
 * login in the default keychain, which macOS looks for under `HOME`. A local
 * run or sign-in has the member directory as its home, where there is none,
 * so macOS would ask in a dialog whose "Reset To Defaults" resets the
 * account's own keychain settings. Each member directory instead gets a login
 * keychain of its own, with a random password kept beside it, owner-only,
 * that never locks on a timer or on sleep and is unlocked before every local
 * run and sign-in. The account's own keychains and search list are never
 * touched. Elsewhere there is nothing to do.
 */
export class MemberKeychain {
    constructor(
        private readonly command: KeychainCommand = security,
        private readonly platform: NodeJS.Platform = process.platform
    ) {}

    /** Creates the member directory's keychain if it has none, and unlocks it. */
    async unlock(directory: string): Promise<void> {
        if (this.platform !== 'darwin') return;
        const keychains = join(directory, 'Library', 'Keychains');
        const keychain = join(keychains, 'login.keychain-db');
        const passwordFile = join(keychains, 'workbench-password');
        if (!(await exists(keychain))) {
            await mkdir(keychains, { recursive: true, mode: 0o700 });
            const password = randomBytes(24).toString('hex');
            await writeFile(passwordFile, password, { mode: 0o600 });
            await this.#run(
                directory,
                [
                    `create-keychain -p ${password} "${keychain}"`,
                    // No timeout and no lock on sleep.
                    `set-keychain-settings "${keychain}"`,
                ],
                'created'
            );
            await chmod(keychain, 0o600);
        }
        const password = await readFile(passwordFile, 'utf8').catch(() => undefined);
        if (!password) {
            throw new Error(
                `The keychain of member directory ${directory} has no password file. Remove ${keychains} and connect again.`
            );
        }
        await this.#run(
            directory,
            [`unlock-keychain -p ${password.trim()} "${keychain}"`],
            'unlocked'
        );
    }

    async #run(home: string, commands: string[], done: string): Promise<void> {
        const result = await this.command(home, `${commands.join('\n')}\n`);
        if (result.code !== 0) {
            const detail = result.stderr.trim().split('\n')[0];
            throw new Error(
                `The member keychain could not be ${done}${detail ? `: ${detail}` : ''}`
            );
        }
    }
}

/** The password goes on standard input, never in a process listing. */
const security: KeychainCommand = async (home, input) => {
    const child = Bun.spawn(['security', '-i'], {
        env: { ...process.env, HOME: home },
        stdin: new Blob([input]),
        stdout: 'ignore',
        stderr: 'pipe',
    });
    const [code, stderr] = await Promise.all([
        child.exited,
        new Response(child.stderr).text(),
    ]);
    return { code, stderr };
};

async function exists(path: string): Promise<boolean> {
    return stat(path).then(
        () => true,
        () => false
    );
}
