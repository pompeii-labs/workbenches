import { posix } from 'node:path';

import type { WorkbenchManifest } from '../types.js';
import { WORKBENCH_USER_AGENT } from '../user-agent.js';
import { WorkbenchManifestParser } from '../workbench/index.js';

const githubApi = 'https://api.github.com';
const maximumPackageFiles = 256;
const maximumPackageBytes = 10 * 1024 * 1024;
const maximumFileBytes = 2 * 1024 * 1024;

export interface GitHubRepository {
    owner: string;
    repo: string;
    source: string;
}

export interface RemotePackageFile {
    path: string;
    bytes: Uint8Array;
    executable: boolean;
}

export interface RemoteWorkbenchSummary {
    selector: string;
    manifest: WorkbenchManifest;
    source: string;
    revision: string;
}

export interface RemoteWorkbenchPackage extends RemoteWorkbenchSummary {
    files: RemotePackageFile[];
}

interface GitHubTreeEntry {
    path: string;
    mode: string;
    type: 'blob' | 'tree' | 'commit';
    sha: string;
    size?: number;
}

interface GitHubInspection {
    repository: GitHubRepository;
    revision: string;
    tree: GitHubTreeEntry[];
}

export interface GitHubSourceOptions {
    fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
    env?: Record<string, string | undefined>;
}

export interface GitHubInspectionOptions {
    revision?: string;
}

export class GitHubWorkbenchSource {
    readonly #fetch: NonNullable<GitHubSourceOptions['fetch']>;
    readonly #env: Record<string, string | undefined>;
    readonly #manifestParser: WorkbenchManifestParser;

    constructor(options: GitHubSourceOptions = {}) {
        this.#fetch = options.fetch ?? fetch;
        this.#env = options.env ?? process.env;
        this.#manifestParser = new WorkbenchManifestParser();
    }

    repository(source: string): GitHubRepository {
        const slug = source.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/);
        if (slug?.[1] && slug[2]) return repository(slug[1], slug[2]);

        let url: URL;
        try {
            url = new URL(source);
        } catch {
            throw new Error(`Workbench source does not exist: ${source}`);
        }
        if (url.protocol !== 'https:') {
            throw new Error('Remote Workbench sources must use HTTPS');
        }
        if (url.hostname.toLowerCase() !== 'github.com') {
            throw new Error(
                `Unsupported remote Workbench host: ${url.hostname}. This version supports github.com.`
            );
        }
        if (url.username || url.password || url.search || url.hash) {
            throw new Error(
                'GitHub Workbench URLs may not contain credentials, queries, or fragments'
            );
        }
        const segments = url.pathname.split('/').filter(Boolean);
        if (segments.length !== 2 || !segments[0] || !segments[1]) {
            throw new Error(`GitHub source must identify one repository: ${source}`);
        }
        return repository(segments[0], segments[1].replace(/\.git$/, ''));
    }

    async list(
        source: string,
        options: GitHubInspectionOptions = {}
    ): Promise<RemoteWorkbenchSummary[]> {
        const inspection = await this.inspect(source, options);
        return this.summaries(inspection);
    }

    async fetch(
        source: string,
        selector?: string,
        options: GitHubInspectionOptions = {}
    ): Promise<RemoteWorkbenchPackage> {
        const inspection = await this.inspect(source, options);
        const available = await this.summaries(inspection);
        const selected = selectSummary(available, selector);
        return this.package(inspection, selected);
    }

    async fetchAll(
        source: string,
        selector?: string,
        options: GitHubInspectionOptions = {}
    ): Promise<RemoteWorkbenchPackage[]> {
        const inspection = await this.inspect(source, options);
        const available = await this.summaries(inspection);
        const selected = selector ? [selectSummary(available, selector)] : available;
        return Promise.all(
            selected.map((workbench) => this.package(inspection, workbench))
        );
    }

    resolve(remote: RemoteWorkbenchSummary) {
        return {
            manifestPath: `github://${remote.source}/.workbenches/${remote.selector}/workbench.yml`,
            packageDirectory: `github://${remote.source}/.workbenches/${remote.selector}`,
            repositoryDirectory: `github://${remote.source}`,
            instructionsPath: `github://${remote.source}/.workbenches/${remote.selector}/${remote.manifest.instructions}`,
            skills: remote.manifest.skills.map((skill) => ({
                name: posix.basename(normalizePackagePath(skill, 'skills')),
                directory: `github://${remote.source}/.workbenches/${remote.selector}/${skill}`,
                manifestPath: `github://${remote.source}/.workbenches/${remote.selector}/${skill}/SKILL.md`,
            })),
            manifest: remote.manifest,
        };
    }

    validate(workbench: RemoteWorkbenchSummary, files: RemotePackageFile[]): void {
        validateRemotePackage(workbench, files, this.#manifestParser);
    }

    private async inspect(
        source: string,
        options: GitHubInspectionOptions
    ): Promise<GitHubInspection> {
        const repository = this.repository(source);
        let reference = options.revision;
        if (!reference) {
            const metadata = await this.requestJson<{ default_branch?: string }>(
                repository,
                `/repos/${repository.owner}/${repository.repo}`
            );
            if (!metadata.default_branch) {
                throw new Error(
                    `GitHub repository has no default branch: ${repository.owner}/${repository.repo}`
                );
            }
            reference = metadata.default_branch;
        }
        const commit = await this.requestJson<{ sha?: string }>(
            repository,
            `/repos/${repository.owner}/${repository.repo}/commits/${encodeURIComponent(reference)}`
        );
        if (!commit.sha) throw malformedResponse(repository);
        const tree = await this.requestJson<{
            truncated?: boolean;
            tree?: GitHubTreeEntry[];
        }>(
            repository,
            `/repos/${repository.owner}/${repository.repo}/git/trees/${commit.sha}?recursive=1`
        );
        if (tree.truncated) {
            throw new Error(
                `GitHub repository tree is too large for safe Workbench inspection: ${repository.owner}/${repository.repo}`
            );
        }
        if (!Array.isArray(tree.tree)) throw malformedResponse(repository);
        return { repository, revision: commit.sha, tree: tree.tree };
    }

    private async summaries(
        inspection: GitHubInspection
    ): Promise<RemoteWorkbenchSummary[]> {
        const manifests = inspection.tree
            .filter(
                (entry) =>
                    entry.type === 'blob' &&
                    /^\.workbenches\/[^/]+\/workbench\.yml$/.test(entry.path)
            )
            .sort((left, right) => left.path.localeCompare(right.path));
        return Promise.all(
            manifests.map(async (entry) => {
                const selector = entry.path.split('/')[1];
                if (!selector) throw malformedResponse(inspection.repository);
                const bytes = await this.fetchBlob(inspection.repository, entry.sha);
                const manifest = this.#manifestParser.parse(
                    Bun.YAML.parse(new TextDecoder().decode(bytes))
                );
                return {
                    selector,
                    manifest,
                    source: inspection.repository.source,
                    revision: inspection.revision,
                };
            })
        );
    }

    private async package(
        inspection: GitHubInspection,
        selected: RemoteWorkbenchSummary
    ): Promise<RemoteWorkbenchPackage> {
        const prefix = `.workbenches/${selected.selector}/`;
        const entries = inspection.tree.filter((entry) =>
            entry.path.startsWith(prefix)
        );
        const unsupported = entries.find(
            (entry) =>
                entry.type === 'commit' ||
                (entry.type === 'blob' && entry.mode === '120000')
        );
        if (unsupported) {
            throw new Error(
                `Remote Workbench packages may not contain symlinks or submodules: ${unsupported.path}`
            );
        }
        const blobs = entries.filter((entry) => entry.type === 'blob');
        if (blobs.length > maximumPackageFiles) {
            throw new Error(
                `Remote Workbench package exceeds ${maximumPackageFiles} files: ${selected.selector}`
            );
        }
        const declaredBytes = blobs.reduce(
            (total, entry) => total + (entry.size ?? 0),
            0
        );
        if (declaredBytes > maximumPackageBytes) {
            throw new Error(
                `Remote Workbench package exceeds ${maximumPackageBytes} bytes: ${selected.selector}`
            );
        }
        for (const entry of blobs) {
            if ((entry.size ?? 0) > maximumFileBytes) {
                throw new Error(`Remote Workbench file is too large: ${entry.path}`);
            }
        }

        const files = await Promise.all(
            blobs.map(async (entry) => ({
                path: entry.path.slice(prefix.length),
                bytes: await this.fetchBlob(inspection.repository, entry.sha),
                executable: entry.mode === '100755',
            }))
        );
        const actualBytes = files.reduce(
            (total, file) => total + file.bytes.byteLength,
            0
        );
        if (actualBytes > maximumPackageBytes) {
            throw new Error(
                `Remote Workbench package exceeds ${maximumPackageBytes} bytes: ${selected.selector}`
            );
        }
        this.validate(selected, files);
        return { ...selected, files };
    }

    private async fetchBlob(
        repository: GitHubRepository,
        sha: string
    ): Promise<Uint8Array> {
        const blob = await this.requestJson<{
            encoding?: string;
            content?: string;
            size?: number;
        }>(
            repository,
            `/repos/${repository.owner}/${repository.repo}/git/blobs/${sha}`
        );
        if (blob.encoding !== 'base64' || typeof blob.content !== 'string') {
            throw malformedResponse(repository);
        }
        if ((blob.size ?? 0) > maximumFileBytes) {
            throw new Error(`Remote Workbench file exceeds ${maximumFileBytes} bytes`);
        }
        return Uint8Array.from(Buffer.from(blob.content.replace(/\s/g, ''), 'base64'));
    }

    private async requestJson<T>(
        repository: GitHubRepository,
        path: string
    ): Promise<T> {
        const token = this.#env.GITHUB_TOKEN ?? this.#env.GH_TOKEN;
        let response: Response;
        try {
            response = await this.#fetch(`${githubApi}${path}`, {
                headers: {
                    Accept: 'application/vnd.github+json',
                    'X-GitHub-Api-Version': '2022-11-28',
                    'User-Agent': WORKBENCH_USER_AGENT,
                    ...(token ? { Authorization: `Bearer ${token}` } : {}),
                },
                signal: AbortSignal.timeout(15_000),
            });
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            throw new Error(
                `Could not reach GitHub while inspecting ${repository.owner}/${repository.repo}: ${detail}`
            );
        }
        if (!response.ok) throw githubResponseError(repository, response);
        try {
            return (await response.json()) as T;
        } catch {
            throw malformedResponse(repository);
        }
    }
}

function selectSummary(
    available: RemoteWorkbenchSummary[],
    selector?: string
): RemoteWorkbenchSummary {
    if (available.length === 0) throw new Error('No Workbenches found in repository');
    if (selector) {
        const selected = available.find(
            (workbench) =>
                workbench.selector === selector || workbench.manifest.name === selector
        );
        if (!selected) throw new Error(`Workbench not found: ${selector}`);
        return selected;
    }
    if (available.length > 1) {
        throw new Error(
            `Workbench selector required. Available: ${available
                .map((workbench) => workbench.selector)
                .join(', ')}`
        );
    }
    return available[0] as RemoteWorkbenchSummary;
}

function validateRemotePackage(
    workbench: RemoteWorkbenchSummary,
    files: RemotePackageFile[],
    manifestParser: WorkbenchManifestParser
): void {
    const indexed = new Map(files.map((file) => [file.path, file]));
    const instructions = normalizePackagePath(
        workbench.manifest.instructions,
        'instructions'
    );
    if (!indexed.has(instructions)) {
        throw new Error(
            `Instructions file does not exist in remote package: ${instructions}`
        );
    }
    const names = new Set<string>();
    for (const skill of workbench.manifest.skills) {
        const directory = normalizePackagePath(skill, 'skills');
        const manifestPath = posix.join(directory, 'SKILL.md');
        const file = indexed.get(manifestPath);
        if (!file) {
            throw new Error(
                `Skill manifest does not exist in remote package: ${manifestPath}`
            );
        }
        const expected = posix.basename(directory);
        const metadata = manifestParser.parseSkill(
            new TextDecoder().decode(file.bytes),
            expected,
            manifestPath
        );
        if (names.has(metadata.name))
            throw new Error(`Duplicate skill name: ${metadata.name}`);
        names.add(metadata.name);
    }
}

function normalizePackagePath(value: string, field: string): string {
    if (value.includes('\\') || posix.isAbsolute(value)) {
        throw new Error(`${field} must be a portable relative path`);
    }
    const normalized = posix.normalize(value);
    if (normalized === '..' || normalized.startsWith('../') || normalized === '.') {
        throw new Error(`${field} must remain inside the Workbench package`);
    }
    return normalized.replace(/^\.\//, '');
}

function githubResponseError(repository: GitHubRepository, response: Response) {
    const name = `${repository.owner}/${repository.repo}`;
    if (response.status === 401) {
        return new Error(
            `GitHub rejected the configured credentials for ${name}. Check GITHUB_TOKEN or GH_TOKEN.`
        );
    }
    if (response.status === 404) {
        return new Error(
            `GitHub repository ${name} was not found or is not accessible with the current credentials.`
        );
    }
    if (response.status === 410) {
        return new Error(`GitHub repository ${name} is gone.`);
    }
    if (response.status === 409) {
        return new Error(
            `GitHub repository ${name} has no inspectable commit history.`
        );
    }
    if (response.status === 451) {
        return new Error(`GitHub repository ${name} is unavailable for legal reasons.`);
    }
    if (
        response.status === 429 ||
        (response.status === 403 &&
            response.headers.get('x-ratelimit-remaining') === '0')
    ) {
        const reset = response.headers.get('x-ratelimit-reset');
        const resetTime = reset
            ? new Date(Number(reset) * 1000).toISOString()
            : undefined;
        return new Error(
            `GitHub rate limit exceeded while inspecting ${name}${resetTime ? `; resets at ${resetTime}` : ''}.`
        );
    }
    if (response.status === 403) {
        return new Error(
            `GitHub denied access to ${name}. Check repository permissions and token scopes.`
        );
    }
    if (response.status >= 500) {
        return new Error(
            `GitHub is unavailable while inspecting ${name} (${response.status}).`
        );
    }
    return new Error(`GitHub could not inspect ${name} (${response.status}).`);
}

function malformedResponse(repository: GitHubRepository) {
    return new Error(
        `GitHub returned a malformed response for ${repository.owner}/${repository.repo}`
    );
}

function repository(owner: string, rawRepo: string): GitHubRepository {
    const repo = rawRepo.replace(/\.git$/, '');
    if (!owner || !repo)
        throw new Error('GitHub repository owner and name are required');
    return { owner, repo, source: `https://github.com/${owner}/${repo}` };
}
