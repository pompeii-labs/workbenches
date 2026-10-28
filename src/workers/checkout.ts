import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import { WorkerRejection } from './contracts.js';
import type { RunWorkspace } from './protocol.js';

/** Who a commit made in the checkout is by, and the address that does not receive mail. */
const COMMIT_AUTHOR = {
    name: 'Workbenches',
    email: 'noreply@workbenches.dev',
};

/** The user the run's credential is presented as in the remote's address. */
const REMOTE_USER = 'workbenches';

/**
 * Every git command the worker runs runs through these overrides: no hooks,
 * no filesystem monitor, no pager, no background maintenance, and no
 * signature verification, so a repository cannot make the worker's git do
 * work, and no redirect, so a fetch stays on the address it was given.
 */
const HARDENING = [
    '-c',
    'http.followRedirects=false',
    '-c',
    'core.hooksPath=/dev/null',
    '-c',
    'core.fsmonitor=false',
    '-c',
    'core.pager=cat',
    '-c',
    'gc.auto=0',
    '-c',
    'log.showSignature=false',
    '-c',
    'gpg.program=/bin/false',
];

/** What git may read from the worker's environment: its isolation and nothing of the account's. */
const GIT_ENVIRONMENT = [
    'PATH',
    'HOME',
    'TMPDIR',
    'GIT_CONFIG_NOSYSTEM',
    'GIT_CONFIG_GLOBAL',
    'GIT_TERMINAL_PROMPT',
    'GH_CONFIG_DIR',
];

const CLONE_TIMEOUT_MS = 10 * 60 * 1000;

const GITHUB_ORIGIN = 'https://github.com';

/**
 * Clones a repository run's code into its workspace directory the way a
 * cloud run's sandbox does: a shallow fetch of the ref through the run's own
 * credential, left on a new local branch with the bot identity when the run
 * may push. No credential of the account is used; the caller passes the
 * isolated environment the run itself gets. The clone runs outside the
 * run's sandbox, so it fetches only from GitHub or the API the worker
 * belongs to, never from this machine or a network it can reach.
 */
export class WorkerCheckout {
    readonly #origins: readonly string[];

    /** `api` is the URL of the API the worker belongs to, whose proxy serves private repositories. */
    constructor(api: string) {
        this.#origins = [GITHUB_ORIGIN, new URL(api).origin];
    }

    /** The address git fetches from and pushes to, with the run's credential in it when there is one. */
    static remote(url: string, credential: string | null): string {
        const address = new URL(url);
        if (credential) {
            address.username = REMOTE_USER;
            address.password = credential;
        }
        return address.toString();
    }

    /** Clones into `directory` and returns the commit it is on. */
    async clone(
        workspace: RunWorkspace,
        directory: string,
        environment: Record<string, string | undefined>
    ): Promise<string> {
        const { credential } = workspace;
        try {
            if (workspace.ref.startsWith('-') || workspace.branch?.startsWith('-'))
                throw new Error('The ref or branch is not valid');
            const origin = new URL(workspace.url).origin;
            if (!this.#origins.includes(origin))
                throw new Error(`${origin} is neither GitHub nor this worker's API`);
            const env = this.#environment(environment);
            const git = (args: string[]) => this.#git(directory, env, args);
            await rm(join(directory, '.git'), { recursive: true, force: true });
            await git(['init', '--quiet']);
            await git([
                'remote',
                'add',
                'origin',
                WorkerCheckout.remote(workspace.url, credential),
            ]);
            await git(['fetch', '--quiet', '--depth', '1', 'origin', workspace.ref]);
            await git(['checkout', '--quiet', '--force', 'FETCH_HEAD']);
            if (workspace.branch) {
                await git(['checkout', '--quiet', '-B', workspace.branch]);
                await git(['config', 'user.name', COMMIT_AUTHOR.name]);
                await git(['config', 'user.email', COMMIT_AUTHOR.email]);
                await git(['config', 'push.autoSetupRemote', 'true']);
            }
            return (await git(['rev-parse', 'HEAD'])).trim();
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            throw new WorkerRejection(
                `The repository could not be fetched: ${WorkerCheckout.scrub(reason, credential)}`
            );
        }
    }

    /** The text with the credential, and the userinfo of any address in it, removed. */
    static scrub(text: string, credential: string | null): string {
        let scrubbed = text;
        if (credential)
            for (const form of new Set([credential, encodeURIComponent(credential)]))
                scrubbed = scrubbed.replaceAll(form, '[redacted]');
        return scrubbed.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi, '$1');
    }

    #environment(
        environment: Record<string, string | undefined>
    ): Record<string, string> {
        const env: Record<string, string> = {};
        for (const name of GIT_ENVIRONMENT) {
            const value = environment[name];
            if (value !== undefined) env[name] = value;
        }
        return env;
    }

    async #git(
        directory: string,
        env: Record<string, string>,
        args: string[]
    ): Promise<string> {
        const child = Bun.spawn(['git', ...HARDENING, ...args], {
            cwd: directory,
            env,
            stdin: 'ignore',
            stdout: 'pipe',
            stderr: 'pipe',
        });
        const timer = setTimeout(() => child.kill(), CLONE_TIMEOUT_MS);
        try {
            const [code, stdout, stderr] = await Promise.all([
                child.exited,
                new Response(child.stdout).text(),
                new Response(child.stderr).text(),
            ]);
            if (code !== 0)
                throw new Error(
                    stderr.trim() || `git ${args[0]} exited with code ${code}`
                );
            return stdout;
        } finally {
            clearTimeout(timer);
        }
    }
}
