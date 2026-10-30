import { WORKBENCH_USER_AGENT } from '../../user-agent.js';
import { RuntimeError } from '../error.js';
import { digestBytes } from '../staging/plan.js';
import type { DaytonaFetch, RegistryLogin, RegistryLogins } from './contracts.js';

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
 * Resolves image tags to digests through the OCI distribution API. It asks
 * anonymously first, signing in for a bearer token when the registry asks for
 * one, and asks again with the login `logins` has for the registry when the
 * registry refuses, as it does for a private image.
 */
export class ImageDigests {
    constructor(
        private readonly fetcher: DaytonaFetch,
        private readonly timeoutMs: number,
        private readonly logins?: RegistryLogins
    ) {}

    async resolve(reference: string): Promise<string> {
        const image = parseImageReference(reference);
        if (image.digest) return image.digest;
        try {
            try {
                return await this.read(image);
            } catch (error) {
                if (!(error instanceof RegistryRefusal) || !this.logins) throw error;
                const login = await this.logins(image.host);
                if (!login) throw error;
                return await this.read(image, login);
            }
        } catch (error) {
            throw new RuntimeError(
                'daytona',
                'prepare',
                `Could not resolve the digest of image ${reference}: ${error instanceof Error ? error.message : String(error)}`,
                { cause: error }
            );
        }
    }

    private async read(image: ImageReference, login?: RegistryLogin): Promise<string> {
        const url = `https://${image.host}/v2/${image.repository}/manifests/${encodeURIComponent(image.tag)}`;
        let response = await this.manifest('HEAD', url);
        let authorization: string | undefined;
        if (response.status === 401) {
            authorization = await this.authorization(response, image.repository, login);
            response = await this.manifest('HEAD', url, authorization);
        }
        const header = this.digestHeader(response, login);
        if (header) return header;
        // A registry may leave the digest header off a HEAD reply, and the
        // digest is then the hash of the manifest bytes.
        response = await this.manifest('GET', url, authorization);
        return (
            this.digestHeader(response, login) ??
            (await digestBytes(new Uint8Array(await response.arrayBuffer())))
        );
    }

    private async manifest(
        method: 'GET' | 'HEAD',
        url: string,
        authorization?: string
    ): Promise<Response> {
        return this.fetcher(url, {
            method,
            headers: {
                Accept: manifestTypes,
                'User-Agent': WORKBENCH_USER_AGENT,
                ...(authorization ? { Authorization: authorization } : {}),
            },
            signal: AbortSignal.timeout(this.timeoutMs),
        });
    }

    /** The digest a successful reply reports, failing on any other reply. */
    private digestHeader(
        response: Response,
        login?: RegistryLogin
    ): string | undefined {
        if (!response.ok) {
            if (response.status === 401 || response.status === 403)
                throw new RegistryRefusal(
                    `the registry refused ${login ? 'the saved login' : 'anonymous access'} (${response.status})`
                );
            throw new Error(`the registry answered ${response.status}`);
        }
        const digest = response.headers.get('docker-content-digest')?.trim();
        return digest && digestPattern.test(digest) ? digest : undefined;
    }

    /**
     * The `Authorization` a 401 reply asks for: a pull token from its bearer
     * challenge, anonymous or for `login`, or `login` itself for basic access.
     */
    private async authorization(
        response: Response,
        repository: string,
        login?: RegistryLogin
    ): Promise<string> {
        await response.body?.cancel().catch(() => {});
        const basic = login
            ? `Basic ${btoa(`${login.username}:${login.secret}`)}`
            : undefined;
        const challenge = bearerChallenge(response.headers.get('www-authenticate'));
        if (!challenge.realm) {
            if (basic) return basic;
            throw new RegistryRefusal('the registry requires credentials');
        }
        const url = new URL(challenge.realm);
        if (challenge.service) url.searchParams.set('service', challenge.service);
        url.searchParams.set(
            'scope',
            challenge.scope ?? `repository:${repository}:pull`
        );
        const reply = await this.fetcher(url, {
            headers: {
                Accept: 'application/json',
                'User-Agent': WORKBENCH_USER_AGENT,
                ...(basic ? { Authorization: basic } : {}),
            },
            signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (!reply.ok) {
            const message = `the registry token service answered ${reply.status}`;
            throw reply.status === 401 || reply.status === 403
                ? new RegistryRefusal(message)
                : new Error(message);
        }
        const body: unknown = await reply.json();
        const token =
            typeof body === 'object' && body !== null
                ? (Reflect.get(body, 'token') ?? Reflect.get(body, 'access_token'))
                : undefined;
        if (typeof token !== 'string' || !token) {
            throw new Error('the registry token service returned no token');
        }
        return `Bearer ${token}`;
    }
}

/** A registry turned the request away for want of access. */
class RegistryRefusal extends Error {}

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
