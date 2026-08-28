import {
    GitHubWorkbenchSource,
    type RemoteWorkbenchPackage,
} from '../sources/index.js';
import { WORKBENCH_USER_AGENT } from '../user-agent.js';
import { WorkbenchManifestParser } from '../workbench/index.js';

const defaultRegistryUrl = 'https://api.workbenches.dev';

export interface RegistryReference {
    publisher: string;
    workbench: string;
}

export interface RegistryPackage {
    reference: RegistryReference;
    registryUrl: string;
    versionId: string;
    version: string;
    digest: string;
    source: string;
    selector: string;
    revision: string;
    artifactUrl?: string;
}

export interface RegistryClientOptions {
    fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
    apiUrl?: string;
}

export interface RegistryRequestOptions {
    method?: string;
    token?: string;
    body?: unknown;
    timeout?: number;
}

export class RegistryClient {
    private static apiUrlOverride: string | undefined;

    readonly apiUrl: string;
    private readonly fetcher: NonNullable<RegistryClientOptions['fetch']>;
    private readonly manifestParser = new WorkbenchManifestParser();
    private readonly packageValidator = new GitHubWorkbenchSource();

    constructor(options: RegistryClientOptions = {}) {
        this.apiUrl = RegistryClient.normalizeUrl(
            options.apiUrl ?? RegistryClient.configuredApiUrl()
        );
        this.fetcher = options.fetch ?? fetch;
    }

    static configureApiUrl(value: string | undefined): void {
        RegistryClient.apiUrlOverride = value
            ? RegistryClient.normalizeUrl(value)
            : undefined;
    }

    static configuredApiUrl(): string {
        return RegistryClient.normalizeUrl(
            RegistryClient.apiUrlOverride ?? defaultRegistryUrl
        );
    }

    static parseReference(value: string): RegistryReference | undefined {
        const match = value.match(
            /^([a-z0-9]+(?:-[a-z0-9]+)*)\/([a-z0-9]+(?:-[a-z0-9]+)*)$/
        );
        if (!match?.[1] || !match[2]) return undefined;
        return { publisher: match[1], workbench: match[2] };
    }

    get imageHost(): string {
        const api = new URL(this.apiUrl);
        return api.hostname === 'api.workbenches.dev'
            ? 'images.workbenches.dev'
            : api.host;
    }

    get imageOrigin(): string {
        const api = new URL(this.apiUrl);
        return api.hostname === 'api.workbenches.dev'
            ? 'https://images.workbenches.dev'
            : api.origin;
    }

    async request<T>(path: string, options: RegistryRequestOptions = {}): Promise<T> {
        if (!path.startsWith('/v1/')) {
            throw new Error('Workbench registry requests must use a /v1 route');
        }
        let response: Response;
        try {
            response = await this.fetcher(`${this.apiUrl}${path}`, {
                method: options.method ?? 'GET',
                headers: {
                    Accept: 'application/json',
                    'User-Agent': WORKBENCH_USER_AGENT,
                    ...(options.token
                        ? { Authorization: `Bearer ${options.token}` }
                        : {}),
                    ...(options.body === undefined
                        ? {}
                        : { 'Content-Type': 'application/json' }),
                },
                ...(options.body === undefined
                    ? {}
                    : { body: JSON.stringify(options.body) }),
                signal: AbortSignal.timeout(options.timeout ?? 20_000),
            });
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            throw new Error(`Could not reach the Workbench registry: ${detail}`);
        }
        const value: unknown = await response.json().catch(() => null);
        if (!response.ok) {
            const message =
                RegistryClient.isRecord(value) &&
                RegistryClient.isRecord(value.error) &&
                typeof value.error.message === 'string'
                    ? value.error.message
                    : `Workbench registry request failed (HTTP ${response.status})`;
            throw new Error(message);
        }
        return value as T;
    }

    async resolve(reference: RegistryReference): Promise<RegistryPackage | undefined> {
        const url = new URL(`${this.apiUrl}/v1/resolutions`);
        let response: Response;
        try {
            response = await this.fetcher(url, {
                method: 'POST',
                headers: {
                    Accept: 'application/json',
                    'Content-Type': 'application/json',
                    'User-Agent': WORKBENCH_USER_AGENT,
                },
                body: JSON.stringify(reference),
                signal: AbortSignal.timeout(10_000),
            });
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            throw new Error(`Could not reach the Workbench registry: ${detail}`);
        }
        if (response.status === 404) return undefined;
        if (!response.ok) {
            throw new Error(
                `The Workbench registry could not resolve ${reference.publisher}/${reference.workbench} (HTTP ${response.status})`
            );
        }

        const value: unknown = await response.json().catch(() => null);
        const parsed = this.parsePackage(value);
        if (!parsed) {
            throw new Error(
                'The Workbench registry returned a malformed package record'
            );
        }
        const selector = RegistryClient.sourceSelector(
            parsed.source_path,
            reference.workbench
        );
        return {
            reference,
            registryUrl: this.apiUrl,
            versionId: parsed.latest_version.id,
            version: parsed.latest_version.version,
            digest: `sha256:${parsed.latest_version.digest}`,
            source:
                parsed.repository?.url ??
                `${reference.publisher}/${reference.workbench}`,
            selector,
            revision: parsed.latest_version.source_commit,
            ...(parsed.latest_version.artifact_url
                ? { artifactUrl: parsed.latest_version.artifact_url }
                : {}),
        };
    }

    async fetchWorkbench(registry: RegistryPackage): Promise<RemoteWorkbenchPackage> {
        if (!registry.artifactUrl) {
            throw new Error('The registry package does not include an artifact');
        }
        let response: Response;
        try {
            response = await this.fetcher(registry.artifactUrl, {
                headers: {
                    Accept: 'application/json',
                    'User-Agent': WORKBENCH_USER_AGENT,
                },
                signal: AbortSignal.timeout(20_000),
            });
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            throw new Error(`Could not download the Workbench package: ${detail}`);
        }
        if (!response.ok) {
            throw new Error(
                `The Workbench package could not be downloaded (HTTP ${response.status})`
            );
        }
        const value: unknown = await response.json().catch(() => null);
        const files = this.parseArtifactFiles(value);
        const manifestFile = files.find((file) => file.path === 'workbench.yml');
        if (!manifestFile) {
            throw new Error('The registry package does not contain workbench.yml');
        }
        const manifest = this.manifestParser.parse(
            Bun.YAML.parse(new TextDecoder().decode(manifestFile.bytes))
        );
        const summary = {
            selector: registry.selector,
            manifest,
            source: registry.source,
            revision: registry.revision,
        };
        this.packageValidator.validate(summary, files);
        return { ...summary, files };
    }

    private parsePackage(value: unknown): {
        source_path: string;
        repository: { url: string } | null;
        latest_version: {
            id: string;
            version: string;
            digest: string;
            source_commit: string;
            artifact_url: string | null;
        };
    } | null {
        if (!RegistryClient.isRecord(value)) return null;
        const repository = value.repository;
        const version = value.latest_version;
        if (
            (repository !== null && !RegistryClient.isRecord(repository)) ||
            !RegistryClient.isRecord(version)
        ) {
            return null;
        }
        if (
            typeof value.source_path !== 'string' ||
            (repository !== null && typeof repository.url !== 'string') ||
            typeof version.id !== 'string' ||
            typeof version.version !== 'string' ||
            typeof version.digest !== 'string' ||
            !/^[0-9a-f]{64}$/.test(version.digest) ||
            typeof version.source_commit !== 'string' ||
            !/^[0-9a-f]{40,64}$/.test(version.source_commit) ||
            (version.artifact_url !== null &&
                version.artifact_url !== undefined &&
                typeof version.artifact_url !== 'string')
        ) {
            return null;
        }
        try {
            if (repository && typeof repository.url === 'string') {
                const source = new URL(repository.url);
                if (source.protocol !== 'https:' || source.hostname !== 'github.com')
                    return null;
            }
            if (typeof version.artifact_url === 'string') {
                const artifact = new URL(version.artifact_url);
                if (artifact.origin !== new URL(this.apiUrl).origin) return null;
                if (artifact.username || artifact.password) return null;
            }
        } catch {
            return null;
        }
        return {
            source_path: value.source_path,
            repository: repository ? { url: repository.url as string } : null,
            latest_version: {
                id: version.id,
                version: version.version,
                digest: version.digest,
                source_commit: version.source_commit,
                artifact_url:
                    typeof version.artifact_url === 'string'
                        ? version.artifact_url
                        : null,
            },
        };
    }

    private parseArtifactFiles(value: unknown): RemoteWorkbenchPackage['files'] {
        if (
            !RegistryClient.isRecord(value) ||
            value.format !== 1 ||
            !Array.isArray(value.files)
        ) {
            throw new Error('The Workbench registry returned a malformed artifact');
        }
        if (value.files.length < 2 || value.files.length > 256) {
            throw new Error('The Workbench registry returned an invalid file count');
        }
        const paths = new Set<string>();
        return value.files.map((file) => {
            if (
                !RegistryClient.isRecord(file) ||
                typeof file.path !== 'string' ||
                !file.path ||
                file.path.includes('\\') ||
                file.path.startsWith('/') ||
                file.path.split('/').includes('..') ||
                paths.has(file.path) ||
                typeof file.content !== 'string' ||
                typeof file.executable !== 'boolean' ||
                file.content.length % 4 !== 0 ||
                !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
                    file.content
                )
            ) {
                throw new Error('The Workbench registry returned a malformed artifact');
            }
            paths.add(file.path);
            const bytes = Uint8Array.from(Buffer.from(file.content, 'base64'));
            if (bytes.byteLength > 2 * 1024 * 1024) {
                throw new Error(`Workbench package file is too large: ${file.path}`);
            }
            return {
                path: file.path,
                bytes,
                executable: file.executable,
            };
        });
    }

    private static normalizeUrl(value: string): string {
        let url: URL;
        try {
            url = new URL(value);
        } catch {
            throw new Error(`Invalid Workbench registry URL: ${value}`);
        }
        const loopback =
            url.hostname === 'localhost' ||
            url.hostname === '127.0.0.1' ||
            url.hostname === '[::1]';
        if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
            throw new Error(
                'Workbench registry URLs must use HTTPS except on localhost'
            );
        }
        if (url.username || url.password || url.search || url.hash) {
            throw new Error(
                'Workbench registry URLs may not contain credentials or queries'
            );
        }
        return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
    }

    private static sourceSelector(path: string, fallback: string): string {
        if (path === 'workbench.yml') return fallback;
        const match = path.match(/^\.workbenches\/([^/]+)\/workbench\.ya?ml$/);
        if (!match?.[1]) {
            throw new Error('The Workbench registry returned an invalid source path');
        }
        return match[1];
    }

    private static isRecord(value: unknown): value is Record<string, unknown> {
        return typeof value === 'object' && value !== null && !Array.isArray(value);
    }
}
