export interface RepositoryRequest {
    repository: string;
    ref?: string;
}

/** Non-secret, immutable repository input shared by every attempt in a session. */
export interface RepositoryBinding {
    owner: string;
    name: string;
    default_branch: string;
    base_branch: string;
    revision: string;
    tree: string;
    session_id: string;
    /** Persisted legacy field: 'pr' grants GitHub credentials; it never auto-publishes a PR. */
    delivery: 'none' | 'pr';
}

export interface RepositoryDeliveryReceipt {
    version: 1;
    run_id: string;
    session_id?: string;
    outcome_id: string;
    repository: string;
    revision: string;
    branch: string;
    base_branch: string;
    created_at: string;
    state: 'publishing' | 'published' | 'failed' | 'unchanged';
    tree?: string;
    commit?: string;
    pull_request?: { number: number; url: string };
    message?: string;
    parent?: string;
    title?: string;
    body?: string;
    commit_message?: string;
    updated?: boolean;
}

export function parseRepository(value: string): { owner: string; name: string } {
    const match =
        /^(?:https:\/\/github\.com\/)?([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9_.-]{1,100})(?:\.git)?\/?$/.exec(
            value
        );
    if (!match)
        throw new Error(
            '--repo requires a GitHub owner/repository or HTTPS repository URL'
        );
    const owner = match[1];
    const name = match[2]?.replace(/\.git$/, '');
    if (!owner || !name || name === '.' || name === '..')
        throw new Error('Invalid GitHub repository name');
    return { owner, name };
}

export function assertRepositoryBinding(binding: RepositoryBinding): void {
    const parsed = parseRepository(`${binding.owner}/${binding.name}`);
    if (
        parsed.owner !== binding.owner ||
        parsed.name !== binding.name ||
        !/^[a-f0-9]{40}$/.test(binding.revision) ||
        !/^[a-f0-9]{40}$/.test(binding.tree) ||
        !/^wb_[a-z0-9]{20,64}$/.test(binding.session_id) ||
        !validRepositoryRef(binding.default_branch) ||
        !validRepositoryRef(binding.base_branch) ||
        !['none', 'pr'].includes(binding.delivery)
    ) {
        throw new Error('Invalid stored repository binding');
    }
}

export function validRepositoryRef(value: unknown): value is string {
    return (
        typeof value === 'string' &&
        value.length > 0 &&
        value.length <= 1024 &&
        ![...value].some(
            (character) =>
                character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
        )
    );
}
