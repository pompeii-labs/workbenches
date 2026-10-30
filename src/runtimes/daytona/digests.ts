import { WORKBENCH_USER_AGENT } from '../../user-agent.js';
import { RuntimeError } from '../error.js';
import { digestBytes } from '../staging/plan.js';
import type { DaytonaFetch } from './contracts.js';

const digestPattern = /^sha256:[a-f0-9]{64}$/;

/** Every manifest form a registry may answer with, single and multi-platform. */
const manifestTypes = [
    'application/vnd.oci.image.index.v1+json',
    'application/vnd.docker.distribution.manifest.list.v2+json',
    'application/vnd.oci.image.manifest.v1+json',
    'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

/** An image reference split the way the OCI distribution API addresses it. */
export interface ImageReference {
    /** The reference as written, without its tag or digest. */
    name: string;
    /** The host the distribution API is served from. */
    host: string;
    repository: string;
    tag: string;
    digest?: string;
}

/** Splits an image reference, with Docker Hub's defaults for short names. */
export function parseImageReference(reference: string): ImageReference {
    const trimmed = reference.trim();
    const invalid = (): never => {
        throw new RuntimeError(
            'daytona',
            'prepare',
            `Invalid Daytona image reference: ${JSON.stringify(reference)}`
        );
    };
    if (!trimmed || /[\s\0]/.test(trimmed)) invalid();
    const [named = '', digest, ...extra] = trimmed.split('@');
    if (extra.length > 0 || (digest !== undefined && !digestPattern.test(digest))) {
        invalid();
    }
    const slash = named.indexOf('/');
    const first = slash === -1 ? '' : named.slice(0, slash);
    const registry =
        first.includes('.') || first.includes(':') || first === 'localhost'
            ? first
            : undefined;
    const path = registry ? named.slice(slash + 1) : named;
    const colon = path.lastIndexOf(':');
    const tagged = colon > path.lastIndexOf('/');
    const repository = tagged ? path.slice(0, colon) : path;
    if (!repository || (tagged && colon === path.length - 1)) invalid();
    const hub = registry === undefined || registry === 'docker.io';
    return {
        name: tagged ? named.slice(0, named.length - (path.length - colon)) : named,
        host: hub ? 'registry-1.docker.io' : (registry ?? ''),
        repository:
            hub && !repository.includes('/') ? `library/${repository}` : repository,
        tag: tagged ? path.slice(colon + 1) : 'latest',
        ...(digest !== undefined ? { digest } : {}),
    };
}

/** `reference` pinned to `digest`, as an image a snapshot is made from. */
export function pinnedImage(reference: string, digest: string): string {
    return `${parseImageReference(reference).name}@${digest}`;
}

/**
 * Resolves image tags to digests through the OCI distribution API, signing
 * in anonymously when the registry asks for a bearer token. It sends no
 * credential of its own, so it reaches public images only.
 */
export class ImageDigests {
    constructor(
        private readonly fetcher: DaytonaFetch,
        private readonly timeoutMs: number
    ) {}

    async resolve(reference: string): Promise<string> {
        const image = parseImageReference(reference);
        if (image.digest) return image.digest;
        try {
            const url = `https://${image.host}/v2/${image.repository}/manifests/${encodeURIComponent(image.tag)}`;
            let response = await this.manifest('HEAD', url);
            let token: string | undefined;
            if (response.status === 401) {
                token = await this.token(response, image.repository);
                response = await this.manifest('HEAD', url, token);
            }
            const header = this.digestHeader(response);
            if (header) return header;
            // A registry may leave the digest header off a HEAD reply, and the
            // digest is then the hash of the manifest bytes.
            response = await this.manifest('GET', url, token);
            return (
                this.digestHeader(response) ??
                (await digestBytes(new Uint8Array(await response.arrayBuffer())))
            );
        } catch (error) {
            throw new RuntimeError(
                'daytona',
                'prepare',
                `Could not resolve the digest of image ${reference}: ${error instanceof Error ? error.message : String(error)}`,
                { cause: error }
            );
        }
    }

    private async manifest(
        method: 'GET' | 'HEAD',
        url: string,
        token?: string
    ): Promise<Response> {
        return this.fetcher(url, {
            method,
            headers: {
                Accept: manifestTypes,
                'User-Agent': WORKBENCH_USER_AGENT,
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
            },
            signal: AbortSignal.timeout(this.timeoutMs),
        });
    }

    /** The digest a successful reply reports, failing on any other reply. */
    private digestHeader(response: Response): string | undefined {
        if (!response.ok) {
            throw new Error(
                response.status === 401 || response.status === 403
                    ? `the registry refused anonymous access (${response.status})`
                    : `the registry answered ${response.status}`
            );
        }
        const digest = response.headers.get('docker-content-digest')?.trim();
        return digest && digestPattern.test(digest) ? digest : undefined;
    }

    /** An anonymous pull token from the challenge in a 401 reply. */
    private async token(response: Response, repository: string): Promise<string> {
        await response.body?.cancel().catch(() => {});
        const challenge = bearerChallenge(response.headers.get('www-authenticate'));
        if (!challenge.realm) {
            throw new Error('the registry requires credentials');
        }
        const url = new URL(challenge.realm);
        if (challenge.service) url.searchParams.set('service', challenge.service);
        url.searchParams.set(
            'scope',
            challenge.scope ?? `repository:${repository}:pull`
        );
        const reply = await this.fetcher(url, {
            headers: { Accept: 'application/json', 'User-Agent': WORKBENCH_USER_AGENT },
            signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (!reply.ok) {
            throw new Error(`the registry token service answered ${reply.status}`);
        }
        const body: unknown = await reply.json();
        const token =
            typeof body === 'object' && body !== null
                ? (Reflect.get(body, 'token') ?? Reflect.get(body, 'access_token'))
                : undefined;
        if (typeof token !== 'string' || !token) {
            throw new Error('the registry token service returned no token');
        }
        return token;
    }
}

/** The parameters of a `Bearer` challenge, or none for any other scheme. */
function bearerChallenge(header: string | null): Record<string, string | undefined> {
    const match = header?.match(/^\s*Bearer\s+(.*)$/i);
    if (!match?.[1]) return {};
    const parameters: Record<string, string> = {};
    for (const [, key, value] of match[1].matchAll(/([A-Za-z]+)="([^"]*)"/g)) {
        if (key && value !== undefined) parameters[key.toLowerCase()] = value;
    }
    return parameters;
}
