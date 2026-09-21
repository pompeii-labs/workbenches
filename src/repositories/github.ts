import {
    assertRepositoryBinding,
    parseRepository,
    type RepositoryBinding,
    type RepositoryRequest,
} from './contracts.js';
import { RepositoryCredentials } from './credentials.js';

export class GitHubRequestError extends Error {
    constructor(
        readonly status: number,
        method: string
    ) {
        super(
            `GitHub ${method} request failed with HTTP ${status}${status === 401 || status === 403 ? '. Check repository access and permissions.' : ''}`
        );
    }
}

export interface GitHubCommitIdentity {
    name: string;
    email: string;
}

/** Fixed-origin client. Response bodies and credential values never become diagnostics. */
export class RepositoryGitHub {
    constructor(
        private readonly token?: string,
        private readonly fetcher: typeof fetch = fetch
    ) {}

    /** Resolve commit attribution from the same credential used by the run. */
    async commitIdentity(): Promise<GitHubCommitIdentity> {
        if (!this.token)
            throw new Error('GitHub authentication is required for commit identity');
        let response: Response;
        try {
            response = await this.fetcher('https://api.github.com/user', {
                redirect: 'error',
                signal: AbortSignal.timeout(60_000),
                headers: {
                    accept: 'application/vnd.github+json',
                    'X-GitHub-Api-Version': '2026-03-10',
                    authorization: `Bearer ${this.token}`,
                },
            });
        } catch {
            throw new Error('GitHub account identity could not be resolved');
        }
        if (!response.ok) throw new GitHubRequestError(response.status, 'GET');
        let user: { id?: unknown; login?: unknown; created_at?: unknown };
        try {
            user = (await response.json()) as typeof user;
        } catch {
            throw new Error('GitHub returned an invalid account identity');
        }
        if (
            !Number.isSafeInteger(user.id) ||
            (user.id as number) < 1 ||
            typeof user.login !== 'string' ||
            !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(user.login) ||
            typeof user.created_at !== 'string' ||
            !Number.isFinite(Date.parse(user.created_at))
        )
            throw new Error('GitHub returned an invalid account identity');
        // GitHub's no-reply address changed for accounts created after July 18, 2017.
        const modern = Date.parse(user.created_at) >= Date.UTC(2017, 6, 18);
        return {
            name: user.login,
            email: `${modern ? `${user.id}+` : ''}${user.login}@users.noreply.github.com`,
        };
    }

    async request<T>(
        owner: string,
        name: string,
        path = '',
        body?: unknown,
        requestMethod?: 'PATCH'
    ): Promise<T> {
        const repository = parseRepository(`${owner}/${name}`);
        const method = requestMethod ?? (body === undefined ? 'GET' : 'POST');
        let response: Response;
        try {
            response = await this.fetcher(
                `https://api.github.com/repos/${repository.owner}/${repository.name}${path}`,
                {
                    method,
                    redirect: 'error',
                    signal: AbortSignal.timeout(60_000),
                    headers: {
                        accept: 'application/vnd.github+json',
                        'X-GitHub-Api-Version': '2026-03-10',
                        ...(this.token
                            ? { authorization: `Bearer ${this.token}` }
                            : {}),
                        ...(body === undefined
                            ? {}
                            : { 'content-type': 'application/json' }),
                    },
                    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
                }
            );
        } catch {
            throw new Error(
                `GitHub ${method} request could not be completed. Saved work is retained; retry the operation.`
            );
        }
        if (!response.ok) throw new GitHubRequestError(response.status, method);
        try {
            return (await response.json()) as T;
        } catch {
            throw new Error('GitHub returned an invalid response');
        }
    }

    async jobLogs(
        owner: string,
        name: string,
        jobId: number
    ): Promise<{ text: string; truncated: boolean }> {
        const repository = parseRepository(`${owner}/${name}`);
        let response: Response;
        try {
            response = await this.fetcher(
                `https://api.github.com/repos/${repository.owner}/${repository.name}/actions/jobs/${jobId}/logs`,
                {
                    redirect: 'manual',
                    signal: AbortSignal.timeout(60_000),
                    headers: {
                        accept: 'application/vnd.github+json',
                        ...(this.token
                            ? { authorization: `Bearer ${this.token}` }
                            : {}),
                    },
                }
            );
            if (response.status === 302) {
                const target = new URL(response.headers.get('location') ?? '');
                if (
                    target.protocol !== 'https:' ||
                    target.username ||
                    target.password ||
                    !/\.(?:githubusercontent\.com|blob\.core\.windows\.net)$/.test(
                        target.hostname
                    )
                )
                    throw new Error('Invalid CI log destination');
                // Signed download URLs are never returned, persisted, or sent account credentials.
                response = await this.fetcher(target, {
                    redirect: 'error',
                    signal: AbortSignal.timeout(60_000),
                });
            }
        } catch {
            throw new Error('GitHub CI logs could not be downloaded');
        }
        if (!response.ok) throw new GitHubRequestError(response.status, 'GET');
        const reader = response.body?.getReader();
        if (!reader) return { text: '', truncated: false };
        const limit = 128 * 1024;
        const chunks: Uint8Array[] = [];
        let length = 0;
        let truncated = false;
        try {
            while (true) {
                const chunk = await reader.read();
                if (chunk.done) break;
                const remaining = limit - length;
                chunks.push(chunk.value.subarray(0, remaining));
                length += Math.min(remaining, chunk.value.length);
                if (chunk.value.length > remaining || length === limit) {
                    truncated = true;
                    await reader.cancel();
                    break;
                }
            }
        } catch {
            await reader.cancel().catch(() => {});
            throw new Error('GitHub CI logs could not be downloaded');
        } finally {
            reader.releaseLock();
        }
        return { text: Buffer.concat(chunks).toString('utf8'), truncated };
    }

    async resolve(
        request: RepositoryRequest,
        sessionId: string
    ): Promise<RepositoryBinding> {
        const repository = parseRepository(request.repository);
        const info = await this.request<{ default_branch: string }>(
            repository.owner,
            repository.name
        );
        if (typeof info.default_branch !== 'string' || !info.default_branch)
            throw new Error('GitHub repository has no default branch');
        const ref = request.ref ?? info.default_branch;
        if (!ref || /[\0\r\n]/.test(ref) || ref.length > 1024)
            throw new Error('Invalid repository ref');
        let baseBranch = info.default_branch;
        if (request.ref) {
            try {
                const branch = await this.request<{ name: string }>(
                    repository.owner,
                    repository.name,
                    `/branches/${encodeURIComponent(ref)}`
                );
                if (branch.name === ref) baseBranch = ref;
            } catch (error) {
                if (!(error instanceof GitHubRequestError && error.status === 404))
                    throw error;
            }
        }
        const commit = await this.request<{
            sha: string;
            commit: { tree: { sha: string } };
        }>(repository.owner, repository.name, `/commits/${encodeURIComponent(ref)}`);
        const binding: RepositoryBinding = {
            ...repository,
            default_branch: info.default_branch,
            base_branch: baseBranch,
            revision: commit.sha,
            tree: commit.commit?.tree?.sha,
            session_id: sessionId,
            delivery: 'pr',
        };
        assertRepositoryBinding(binding);
        return binding;
    }

    static async forEnvironment(
        environment: Record<string, string | undefined>,
        required = false
    ): Promise<RepositoryGitHub> {
        return new RepositoryGitHub(
            await new RepositoryCredentials(environment).token(required)
        );
    }
}
