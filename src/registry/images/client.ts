import type { OciDescriptor } from './archive.js';

const uploadChunkSize = 16 * 1024 * 1024;

export interface OciRegistryClientOptions {
    origin: string;
    host: string;
    publisher: string;
    image: string;
    accountToken: string;
    fetch?: typeof fetch;
}

export class OciRegistryClient {
    private readonly fetcher: typeof fetch;
    private readonly repositoryUrl: string;
    private token: string | undefined;

    constructor(private readonly options: OciRegistryClientOptions) {
        this.fetcher = options.fetch ?? fetch;
        this.repositoryUrl = `${options.origin}/v2/${options.publisher}/${options.image}`;
    }

    async hasBlob(digest: string): Promise<boolean> {
        const response = await this.request(`${this.repositoryUrl}/blobs/${digest}`, {
            method: 'HEAD',
        });
        if (response.status === 404) return false;
        if (!response.ok) throw await this.error(response, 'check OCI blob');
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
            for await (const chunk of OciRegistryClient.chunks(stream)) {
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
                throw await this.error(response, 'complete OCI blob upload');
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
            throw await this.error(response, 'publish OCI manifest');
        }
    }

    private async startUpload(): Promise<string> {
        const response = await this.request(`${this.repositoryUrl}/blobs/uploads/`, {
            method: 'POST',
            headers: { 'Content-Length': '0' },
        });
        if (response.status !== 202) {
            throw await this.error(response, 'start OCI blob upload');
        }
        return this.location(response, this.options.origin);
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
                    return this.location(response, location);
                }
                if (response.status !== 416 && response.status < 500) {
                    throw await this.error(response, 'upload OCI blob chunk');
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
            throw await this.error(response, 'read OCI upload status');
        }
        const range = response.headers.get('range');
        const match = range ? /^(?:bytes=)?0-(\d+)$/.exec(range) : null;
        return {
            offset: match?.[1] ? Number(match[1]) + 1 : 0,
            location: this.location(response, location),
        };
    }

    private async request(input: string | URL, init: RequestInit): Promise<Response> {
        if (!this.token) this.token = await this.issueToken();
        let response = await this.authorizedRequest(input, init);
        if (response.status !== 401) return response;
        this.token = await this.issueToken();
        response = await this.authorizedRequest(input, init);
        return response;
    }

    private authorizedRequest(
        input: string | URL,
        init: RequestInit
    ): Promise<Response> {
        return this.fetcher(input, {
            ...init,
            headers: { ...init.headers, Authorization: `Bearer ${this.token}` },
        });
    }

    private async issueToken(): Promise<string> {
        const url = new URL('/v2/auth', this.options.origin);
        url.searchParams.set('service', this.options.host);
        url.searchParams.set(
            'scope',
            `repository:${this.options.publisher}/${this.options.image}:pull,push`
        );
        const response = await this.fetcher(url, {
            headers: { Authorization: `Bearer ${this.options.accountToken}` },
        });
        const value: unknown = await response.json().catch(() => null);
        if (
            !response.ok ||
            !OciRegistryClient.isRecord(value) ||
            typeof value.token !== 'string'
        ) {
            throw new Error('OCI registry credentials could not be issued');
        }
        return value.token;
    }

    private location(response: Response, base: string): string {
        const value = response.headers.get('location');
        if (!value) {
            throw new Error('OCI registry response did not include a location');
        }
        return new URL(value, base).toString();
    }

    private async error(response: Response, action: string): Promise<Error> {
        const value: unknown = await response.json().catch(() => null);
        const first =
            OciRegistryClient.isRecord(value) && Array.isArray(value.errors)
                ? value.errors[0]
                : undefined;
        const detail =
            OciRegistryClient.isRecord(first) && typeof first.message === 'string'
                ? first.message
                : `HTTP ${response.status}`;
        return new Error(`Could not ${action}: ${detail}`);
    }

    private static async *chunks(
        source: AsyncIterable<Uint8Array>
    ): AsyncGenerator<Uint8Array> {
        let pending = new Uint8Array(uploadChunkSize);
        let used = 0;
        for await (const value of source) {
            let offset = 0;
            while (offset < value.byteLength) {
                const length = Math.min(
                    uploadChunkSize - used,
                    value.byteLength - offset
                );
                pending.set(value.subarray(offset, offset + length), used);
                used += length;
                offset += length;
                if (used === uploadChunkSize) {
                    yield pending;
                    pending = new Uint8Array(uploadChunkSize);
                    used = 0;
                }
            }
        }
        if (used > 0) yield pending.slice(0, used);
    }

    private static isRecord(value: unknown): value is Record<string, unknown> {
        return typeof value === 'object' && value !== null && !Array.isArray(value);
    }
}
