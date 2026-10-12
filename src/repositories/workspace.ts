import { cp, lstat, mkdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { WorkbenchDatabase } from '../database/workbenchdatabase.js';
import { WorkbenchFiles } from '../files/workbenchfiles.js';
import type { ResolvedWorkbench } from '../types.js';
import { assertRepositoryBinding, type RepositoryBinding } from './contracts.js';
import { RepositoryCredentials } from './credentials.js';
import { RepositoryGit } from './git.js';
import { type GitHubCommitIdentity, RepositoryGitHub } from './github.js';
import { RepositoryCheckoutStore } from './repositorycheckoutstore.js';

/** Persistent engine-owned checkout. The caller directory remains only a discovery scope. */
export class RepositoryWorkspace {
    readonly #files: WorkbenchFiles;
    readonly #checkouts: RepositoryCheckoutStore;

    constructor(
        home: string,
        readonly binding: RepositoryBinding,
        private readonly environment: Record<string, string | undefined>,
        private readonly git = new RepositoryGit(environment),
        private readonly identity = (token: string) =>
            new RepositoryGitHub(token).commitIdentity()
    ) {
        assertRepositoryBinding(binding);
        this.#files = new WorkbenchFiles(home);
        this.#checkouts = new RepositoryCheckoutStore(WorkbenchDatabase.forHome(home));
    }

    get directory(): string {
        return this.#files.checkoutDirectory(this.binding.session_id);
    }

    get agentGitDirectory(): string {
        return this.#files.agentGitDirectory(this.binding.session_id);
    }

    assertCredentialsOwnedByEngine(workbench: ResolvedWorkbench): void {
        const protectedNames = Object.keys(workbench.manifest.env).filter(
            RepositoryCredentials.isProtected
        );
        if (protectedNames.length)
            throw new Error(
                `Repository execution reserves engine-owned credentials: ${protectedNames.join(', ')}`
            );
    }

    async prepare(runtime: string = 'e2b'): Promise<GitHubCommitIdentity | undefined> {
        const parent = this.#files.repositoryParent(this.binding.session_id);
        await mkdir(parent, { recursive: true, mode: 0o700 });
        const details = await lstat(this.directory).catch((error) => {
            if (error?.code === 'ENOENT') return undefined;
            throw error;
        });
        const saved = this.#checkouts.find(this.binding.session_id);
        let existing = false;
        if (details) {
            if (!details.isDirectory() || details.isSymbolicLink())
                throw new Error('Managed repository checkout is not a directory');
            if (!saved)
                throw new Error(
                    'Incomplete repository checkout; saved provenance is missing'
                );
            if (!isDeepStrictEqual(saved, this.binding))
                throw new Error(
                    'Repository checkout provenance does not match the session'
                );
            existing = true;
        } else if (saved) {
            throw new Error(
                'Managed repository checkout is missing; refusing to discard retained session edits'
            );
        }
        const staging = join(parent, `repository.${crypto.randomUUID()}.tmp`);
        const git = this.git;
        const token = await new RepositoryCredentials(this.environment).token(
            this.binding.delivery === 'pr'
        );
        const identity = token ? await this.identity(token) : undefined;
        await mkdir(staging, { mode: 0o700 });
        try {
            await git.execute(staging, ['init', '--template=']);
            await git.execute(
                staging,
                [
                    'fetch',
                    '--depth=1',
                    `https://github.com/${this.binding.owner}/${this.binding.name}.git`,
                    this.binding.revision,
                ],
                token
            );
            await git.execute(staging, ['checkout', '--detach', this.binding.revision]);
            await git.execute(staging, [
                'remote',
                'add',
                'origin',
                `https://github.com/${this.binding.owner}/${this.binding.name}.git`,
            ]);
            if (identity) {
                await git.execute(staging, ['config', 'user.name', identity.name]);
                await git.execute(staging, ['config', 'user.email', identity.email]);
            }
            const revision = await git.execute(staging, ['rev-parse', 'HEAD']);
            const tree = await git.execute(staging, ['rev-parse', 'HEAD^{tree}']);
            if (revision !== this.binding.revision || tree !== this.binding.tree)
                throw new Error(
                    'Repository checkout does not match the selected GitHub commit'
                );
            const agentGit = await lstat(this.agentGitDirectory).catch((error) => {
                if (error?.code === 'ENOENT') return undefined;
                throw error;
            });
            if (agentGit && (!agentGit.isDirectory() || agentGit.isSymbolicLink()))
                throw new Error('Managed agent Git state is not a directory');
            if (!agentGit) {
                const pending = join(parent, `agent-git.${crypto.randomUUID()}.tmp`);
                try {
                    await cp(join(staging, '.git'), pending, { recursive: true });
                    await rename(pending, this.agentGitDirectory);
                } finally {
                    await rm(pending, { recursive: true, force: true });
                }
            }
            if (existing && runtime !== 'local') {
                // Never execute host Git against metadata that a local agent could have modified.
                await rm(join(this.directory, '.git'), {
                    recursive: true,
                    force: true,
                });
                await rename(join(staging, '.git'), join(this.directory, '.git'));
            } else if (!existing) {
                this.#checkouts.record(this.binding.session_id, this.binding);
                try {
                    await rename(staging, this.directory);
                } catch (error) {
                    this.#checkouts.forget(this.binding.session_id);
                    throw error;
                }
            }
        } finally {
            await rm(staging, { recursive: true, force: true });
        }
        return identity;
    }
}
