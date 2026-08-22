import { type RemoteWorkbenchPackage, validateRemotePackage } from './github.js';
import { parseWorkbenchManifest } from './manifest.js';

const defaultRegistryUrl = 'https://api.workbenches.dev';

let registryApiUrlOverride: string | undefined;

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

export interface RegistryDependencies {
    fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
    apiUrl?: string;
}

export function setRegistryApiUrl(value: string | undefined): void {
    registryApiUrlOverride = value ? normalizeRegistryUrl(value) : undefined;
}

export function registryApiUrl(): string {
    return normalizeRegistryUrl(registryApiUrlOverride ?? defaultRegistryUrl);
}

export function registryImageHost(): string {
    const api = new URL(registryApiUrl());
    return api.hostname === 'api.workbenches.dev' ? 'images.workbenches.dev' : api.host;
}

export function parseRegistryReference(value: string): RegistryReference | undefined {
    const match = value.match(
        /^([a-z0-9]+(?:-[a-z0-9]+)*)\/([a-z0-9]+(?:-[a-z0-9]+)*)$/
    );
    if (!match?.[1] || !match[2]) return undefined;
    return { publisher: match[1], workbench: match[2] };
}

export async function resolveRegistryPackage(
    reference: RegistryReference,
    dependencies: RegistryDependencies = {}
): Promise<RegistryPackage | undefined> {
    const registryUrl = normalizeRegistryUrl(dependencies.apiUrl ?? registryApiUrl());
    const url = new URL(`${registryUrl}/v1/resolutions`);
    let response: Response;
    try {
        response = await (dependencies.fetch ?? fetch)(url, {
            method: 'POST',
            headers: {
                Accept: 'application/json',
                'Content-Type': 'application/json',
                'User-Agent': 'pompeii-labs-workbench',
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
    const parsed = parseRegistryResponse(value, registryUrl);
    if (!parsed) {
        throw new Error('The Workbench registry returned a malformed package record');
    }
    const selector = sourceSelector(parsed.source_path, reference.workbench);
    return {
        reference,
        registryUrl,
        versionId: parsed.latest_version.id,
        version: parsed.latest_version.version,
        digest: `sha256:${parsed.latest_version.digest}`,
        source:
            parsed.repository?.url ?? `${reference.publisher}/${reference.workbench}`,
        selector,
        revision: parsed.latest_version.source_commit,
        ...(parsed.latest_version.artifact_url
            ? { artifactUrl: parsed.latest_version.artifact_url }
            : {}),
    };
}

export async function fetchRegistryWorkbench(
    registry: RegistryPackage,
    dependencies: RegistryDependencies = {}
): Promise<RemoteWorkbenchPackage> {
    if (!registry.artifactUrl) {
        throw new Error('The registry package does not include an artifact');
    }
    let response: Response;
    try {
        response = await (dependencies.fetch ?? fetch)(registry.artifactUrl, {
            headers: {
                Accept: 'application/json',
                'User-Agent': 'pompeii-labs-workbench',
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
    const files = registryFiles(value);
    const manifestFile = files.find((file) => file.path === 'workbench.yml');
    if (!manifestFile) {
        throw new Error('The registry package does not contain workbench.yml');
    }
    const manifest = parseWorkbenchManifest(
        Bun.YAML.parse(new TextDecoder().decode(manifestFile.bytes))
    );
    const summary = {
        selector: registry.selector,
        manifest,
        source: registry.source,
        revision: registry.revision,
    };
    validateRemotePackage(summary, files);
    return { ...summary, files };
}

function normalizeRegistryUrl(value: string): string {
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
        throw new Error('Workbench registry URLs must use HTTPS except on localhost');
    }
    if (url.username || url.password || url.search || url.hash) {
        throw new Error(
            'Workbench registry URLs may not contain credentials or queries'
        );
    }
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

function sourceSelector(path: string, fallback: string): string {
    if (path === 'workbench.yml') return fallback;
    const match = path.match(/^\.workbenches\/([^/]+)\/workbench\.ya?ml$/);
    if (!match?.[1]) {
        throw new Error('The Workbench registry returned an invalid source path');
    }
    return match[1];
}

function parseRegistryResponse(
    value: unknown,
    registryUrl: string
): {
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
    if (!isRecord(value)) return null;
    const repository = value.repository;
    const version = value.latest_version;
    if ((repository !== null && !isRecord(repository)) || !isRecord(version))
        return null;
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
            if (artifact.origin !== new URL(registryUrl).origin) return null;
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
                typeof version.artifact_url === 'string' ? version.artifact_url : null,
        },
    };
}

function registryFiles(value: unknown) {
    if (!isRecord(value) || value.format !== 1 || !Array.isArray(value.files)) {
        throw new Error('The Workbench registry returned a malformed artifact');
    }
    if (value.files.length < 2 || value.files.length > 256) {
        throw new Error('The Workbench registry returned an invalid file count');
    }
    const paths = new Set<string>();
    return value.files.map((value) => {
        if (
            !isRecord(value) ||
            typeof value.path !== 'string' ||
            !value.path ||
            value.path.includes('\\') ||
            value.path.startsWith('/') ||
            value.path.split('/').includes('..') ||
            paths.has(value.path) ||
            typeof value.content !== 'string' ||
            typeof value.executable !== 'boolean' ||
            value.content.length % 4 !== 0 ||
            !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
                value.content
            )
        ) {
            throw new Error('The Workbench registry returned a malformed artifact');
        }
        paths.add(value.path);
        const bytes = Uint8Array.from(Buffer.from(value.content, 'base64'));
        if (bytes.byteLength > 2 * 1024 * 1024) {
            throw new Error(`Workbench package file is too large: ${value.path}`);
        }
        return {
            path: value.path,
            bytes,
            executable: value.executable,
        };
    });
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
