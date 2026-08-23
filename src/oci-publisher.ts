import { createReadStream } from 'node:fs';
import { type Entry, extract } from 'tar-stream';

const metadataLimit = 4 * 1024 * 1024;
const uploadChunkSize = 16 * 1024 * 1024;
const manifestMediaType = 'application/vnd.oci.image.manifest.v1+json';

interface OciDescriptor {
    mediaType: string;
    digest: string;
    size: number;
}

interface OciIndex {
    schemaVersion: 2;
    manifests: OciDescriptor[];
}

interface OciManifest {
    schemaVersion: 2;
    mediaType?: string;
    config: OciDescriptor;
    layers: OciDescriptor[];
}

interface ArchiveImage {
    manifest: Uint8Array;
    mediaType: string;
    blobs: OciDescriptor[];
}

export interface OciPublishOptions {
    archive: string;
    registryOrigin: string;
    registryHost: string;
    publisher: string;
    image: string;
    tag: string;
    accountToken: string;
    fetch?: typeof fetch;
    progress?: (event: OciPublishProgress) => void;
}

export type OciPublishProgress =
    | { type: 'inspecting' }
    | { type: 'planned'; blobs: number; missing: number }
    | {
          type: 'uploading';
          blob: number;
          blobs: number;
          mediaType: string;
          uploaded: number;
          size: number;
      }
    | { type: 'manifest' };

export async function publishOciArchive(options: OciPublishOptions): Promise<void> {
    options.progress?.({ type: 'inspecting' });
    const image = await inspectArchive(options.archive);
    const client = new OciRegistryClient(options);
    const missing = new Set<string>();
    for (const blob of image.blobs) {
        if (!(await client.hasBlob(blob.digest))) missing.add(blob.digest);
    }
    options.progress?.({
        type: 'planned',
        blobs: image.blobs.length,
        missing: missing.size,
    });
    if (missing.size > 0) {
        const missingBlobs = missing.size;
        let blob = 0;
        await visitArchive(options.archive, async (entry) => {
            const digest = digestFromPath(entry.header.name);
            if (!digest || !missing.has(digest)) {
                entry.resume();
                return;
            }
            const descriptor = image.blobs.find(
                (candidate) => candidate.digest === digest
            );
            if (!descriptor) {
                entry.resume();
                return;
            }
            if (entry.header.size !== descriptor.size) {
                throw new Error(`OCI blob ${digest} does not match its declared size`);
            }
            blob += 1;
            await client.uploadBlob(entry, descriptor, (uploaded) =>
                options.progress?.({
                    type: 'uploading',
                    blob,
                    blobs: missingBlobs,
                    mediaType: descriptor.mediaType,
                    uploaded,
                    size: descriptor.size,
                })
            );
            missing.delete(digest);
        });
    }
    if (missing.size > 0) {
        throw new Error(`Docker image archive is missing ${[...missing].join(', ')}`);
    }
    options.progress?.({ type: 'manifest' });
    await client.putManifest(options.tag, image.mediaType, image.manifest);
}

async function inspectArchive(path: string): Promise<ArchiveImage> {
    const metadata = new Map<string, Uint8Array>();
    await visitArchive(path, async (entry) => {
        const name = entry.header.name;
        const size = entry.header.size ?? 0;
        if (
            (name === 'index.json' || name.startsWith('blobs/sha256/')) &&
            size <= metadataLimit
        ) {
            metadata.set(name, await readEntry(entry, metadataLimit));
            return;
        }
        entry.resume();
    });
    const index = parseIndex(metadata.get('index.json'));
    if (index.manifests.length !== 1) {
        throw new Error(
            'Docker image archive must contain exactly one platform manifest'
        );
    }
    const manifestDescriptor = index.manifests[0];
    if (!manifestDescriptor) {
        throw new Error('Docker image archive does not contain an OCI manifest');
    }
    const manifestBytes = metadata.get(pathForDigest(manifestDescriptor.digest));
    if (!manifestBytes || manifestBytes.byteLength !== manifestDescriptor.size) {
        throw new Error('Docker image archive is missing its OCI manifest');
    }
    const manifest = parseManifest(manifestBytes);
    return {
        manifest: manifestBytes,
        mediaType:
            manifestDescriptor.mediaType || manifest.mediaType || manifestMediaType,
        blobs: uniqueDescriptors([manifest.config, ...manifest.layers]),
    };
}

class OciRegistryClient {
    private readonly fetcher: typeof fetch;
    private readonly repositoryUrl: string;
    private token: string | undefined;

    constructor(private readonly options: OciPublishOptions) {
        this.fetcher = options.fetch ?? fetch;
        this.repositoryUrl = `${options.registryOrigin}/v2/${options.publisher}/${options.image}`;
    }

    async hasBlob(digest: string): Promise<boolean> {
        const response = await this.request(`${this.repositoryUrl}/blobs/${digest}`, {
            method: 'HEAD',
        });
        if (response.status === 404) return false;
        if (!response.ok) throw await registryError(response, 'check OCI blob');
        return true;
    }

    async uploadBlob(
        stream: AsyncIterable<Uint8Array>,
        descriptor: OciDescriptor,
        progress: (uploaded: number) => void
    ): Promise<void> {
        let location = await this.startUpload();
        let offset = 0;
        try {
            for await (const chunk of fixedChunks(stream, uploadChunkSize)) {
                const end = offset + chunk.byteLength - 1;
                location = await this.patch(location, chunk, offset, end);
                offset = end + 1;
                progress(offset);
            }
            if (offset !== descriptor.size) {
                throw new Error(
                    `OCI blob ${descriptor.digest} produced ${offset} bytes instead of ${descriptor.size}`
                );
            }
            const complete = new URL(location);
            complete.searchParams.set('digest', descriptor.digest);
            const response = await this.request(complete, {
                method: 'PUT',
                headers: { 'Content-Length': '0' },
            });
            if (response.status !== 201) {
                throw await registryError(response, 'complete OCI blob upload');
            }
            const stored = response.headers.get('docker-content-digest');
            if (stored && stored !== descriptor.digest) {
                throw new Error(
                    `OCI registry stored ${stored} instead of ${descriptor.digest}`
                );
            }
        } catch (error) {
            await this.request(location, { method: 'DELETE' }).catch(() => undefined);
            throw error;
        }
    }

    async putManifest(
        tag: string,
        mediaType: string,
        manifest: Uint8Array
    ): Promise<void> {
        const response = await this.request(
            `${this.repositoryUrl}/manifests/${encodeURIComponent(tag)}`,
            {
                method: 'PUT',
                headers: {
                    'Content-Type': mediaType,
                    'Content-Length': String(manifest.byteLength),
                },
                body: manifest,
            }
        );
        if (response.status !== 201) {
            throw await registryError(response, 'publish OCI manifest');
        }
    }

    private async startUpload(): Promise<string> {
        const response = await this.request(`${this.repositoryUrl}/blobs/uploads/`, {
            method: 'POST',
            headers: { 'Content-Length': '0' },
        });
        if (response.status !== 202) {
            throw await registryError(response, 'start OCI blob upload');
        }
        return responseLocation(response, this.options.registryOrigin);
    }

    private async patch(
        location: string,
        chunk: Uint8Array,
        start: number,
        end: number
    ): Promise<string> {
        for (let attempt = 0; attempt < 3; attempt += 1) {
            try {
                const response = await this.request(location, {
                    method: 'PATCH',
                    headers: {
                        'Content-Type': 'application/octet-stream',
                        'Content-Length': String(chunk.byteLength),
                        'Content-Range': `${start}-${end}`,
                    },
                    body: chunk,
                });
                if (response.status === 202) {
                    return responseLocation(response, location);
                }
                if (response.status !== 416 && response.status < 500) {
                    throw await registryError(response, 'upload OCI blob chunk');
                }
            } catch (error) {
                if (attempt === 2) throw error;
            }
            const status = await this.uploadOffset(location);
            if (status.offset === end + 1) return status.location;
            if (status.offset !== start) {
                throw new Error(
                    `OCI upload resumed at byte ${status.offset}, expected ${start}`
                );
            }
        }
        throw new Error('OCI blob chunk could not be uploaded');
    }

    private async uploadOffset(
        location: string
    ): Promise<{ offset: number; location: string }> {
        const response = await this.request(location, { method: 'GET' });
        if (response.status !== 204) {
            throw await registryError(response, 'read OCI upload status');
        }
        const range = response.headers.get('range');
        const match = range ? /^(?:bytes=)?0-(\d+)$/.exec(range) : null;
        return {
            offset: match?.[1] ? Number(match[1]) + 1 : 0,
            location: responseLocation(response, location),
        };
    }

    private async request(input: string | URL, init: RequestInit): Promise<Response> {
        if (!this.token) this.token = await this.issueToken();
        let response = await this.fetcher(input, {
            ...init,
            headers: { ...init.headers, Authorization: `Bearer ${this.token}` },
        });
        if (response.status !== 401) return response;
        this.token = await this.issueToken();
        response = await this.fetcher(input, {
            ...init,
            headers: { ...init.headers, Authorization: `Bearer ${this.token}` },
        });
        return response;
    }

    private async issueToken(): Promise<string> {
        const url = new URL('/v2/auth', this.options.registryOrigin);
        url.searchParams.set('service', this.options.registryHost);
        url.searchParams.set(
            'scope',
            `repository:${this.options.publisher}/${this.options.image}:pull,push`
        );
        const response = await this.fetcher(url, {
            headers: { Authorization: `Bearer ${this.options.accountToken}` },
        });
        const value: unknown = await response.json().catch(() => null);
        if (!response.ok || !isRecord(value) || typeof value.token !== 'string') {
            throw new Error('OCI registry credentials could not be issued');
        }
        return value.token;
    }
}

async function visitArchive(
    path: string,
    visitor: (entry: Entry) => Promise<void>
): Promise<void> {
    const archive = extract();
    createReadStream(path).pipe(archive);
    for await (const entry of archive) {
        if (entry.header.type && entry.header.type !== 'file') {
            entry.resume();
            continue;
        }
        await visitor(entry);
    }
}

async function readEntry(
    entry: AsyncIterable<Uint8Array>,
    limit: number
): Promise<Uint8Array> {
    const parts: Uint8Array[] = [];
    let size = 0;
    for await (const part of entry) {
        size += part.byteLength;
        if (size > limit) throw new Error('OCI archive metadata is too large');
        parts.push(part);
    }
    const value = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) {
        value.set(part, offset);
        offset += part.byteLength;
    }
    return value;
}

async function* fixedChunks(
    source: AsyncIterable<Uint8Array>,
    size: number
): AsyncGenerator<Uint8Array> {
    let pending = new Uint8Array(size);
    let used = 0;
    for await (const value of source) {
        let offset = 0;
        while (offset < value.byteLength) {
            const length = Math.min(size - used, value.byteLength - offset);
            pending.set(value.subarray(offset, offset + length), used);
            used += length;
            offset += length;
            if (used === size) {
                yield pending;
                pending = new Uint8Array(size);
                used = 0;
            }
        }
    }
    if (used > 0) yield pending.slice(0, used);
}

function parseIndex(value: Uint8Array | undefined): OciIndex {
    const parsed = parseJson(value, 'Docker image archive does not contain index.json');
    if (
        !isRecord(parsed) ||
        parsed.schemaVersion !== 2 ||
        !Array.isArray(parsed.manifests) ||
        !parsed.manifests.every(isDescriptor)
    ) {
        throw new Error('Docker image archive contains an invalid OCI index');
    }
    return { schemaVersion: 2, manifests: parsed.manifests };
}

function parseManifest(value: Uint8Array): OciManifest {
    const parsed = parseJson(value, 'OCI manifest is not valid JSON');
    if (
        !isRecord(parsed) ||
        parsed.schemaVersion !== 2 ||
        !isDescriptor(parsed.config) ||
        !Array.isArray(parsed.layers) ||
        !parsed.layers.every(isDescriptor) ||
        (parsed.mediaType !== undefined && typeof parsed.mediaType !== 'string')
    ) {
        throw new Error('Docker image archive contains an invalid OCI manifest');
    }
    return {
        schemaVersion: 2,
        ...(parsed.mediaType ? { mediaType: parsed.mediaType } : {}),
        config: parsed.config,
        layers: parsed.layers,
    };
}

function parseJson(value: Uint8Array | undefined, message: string): unknown {
    if (!value) throw new Error(message);
    try {
        return JSON.parse(new TextDecoder().decode(value));
    } catch {
        throw new Error(message);
    }
}

function isDescriptor(value: unknown): value is OciDescriptor {
    return (
        isRecord(value) &&
        typeof value.mediaType === 'string' &&
        typeof value.digest === 'string' &&
        /^sha256:[0-9a-f]{64}$/.test(value.digest) &&
        Number.isSafeInteger(value.size) &&
        typeof value.size === 'number' &&
        value.size >= 0
    );
}

function uniqueDescriptors(values: OciDescriptor[]): OciDescriptor[] {
    return [...new Map(values.map((value) => [value.digest, value])).values()];
}

function digestFromPath(path: string): string | undefined {
    const match = /^blobs\/sha256\/([0-9a-f]{64})$/.exec(path);
    return match?.[1] ? `sha256:${match[1]}` : undefined;
}

function pathForDigest(digest: string): string {
    return `blobs/sha256/${digest.slice('sha256:'.length)}`;
}

function responseLocation(response: Response, base: string): string {
    const value = response.headers.get('location');
    if (!value) throw new Error('OCI registry response did not include a location');
    return new URL(value, base).toString();
}

async function registryError(response: Response, action: string): Promise<Error> {
    const value: unknown = await response.json().catch(() => null);
    const first =
        isRecord(value) && Array.isArray(value.errors) ? value.errors[0] : undefined;
    const detail =
        isRecord(first) && typeof first.message === 'string'
            ? first.message
            : `HTTP ${response.status}`;
    return new Error(`Could not ${action}: ${detail}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
