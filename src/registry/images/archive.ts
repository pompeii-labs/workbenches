import { createReadStream } from 'node:fs';
import { type Entry, extract } from 'tar-stream';

const metadataLimit = 4 * 1024 * 1024;
const manifestMediaType = 'application/vnd.oci.image.manifest.v1+json';

export interface OciDescriptor {
    mediaType: string;
    digest: string;
    size: number;
}

export interface OciArchiveImage {
    manifest: Uint8Array;
    mediaType: string;
    blobs: OciDescriptor[];
}

export class OciArchive {
    constructor(readonly path: string) {}

    async inspect(): Promise<OciArchiveImage> {
        const metadata = new Map<string, Uint8Array>();
        await this.visit(async (entry) => {
            const name = entry.header.name;
            const size = entry.header.size ?? 0;
            if (
                (name === 'index.json' || name.startsWith('blobs/sha256/')) &&
                size <= metadataLimit
            ) {
                metadata.set(name, await OciArchive.readEntry(entry));
                return;
            }
            entry.resume();
        });
        const index = OciArchive.parseIndex(metadata.get('index.json'));
        if (index.manifests.length !== 1) {
            throw new Error(
                'Docker image archive must contain exactly one platform manifest'
            );
        }
        const descriptor = index.manifests[0];
        if (!descriptor) {
            throw new Error('Docker image archive does not contain an OCI manifest');
        }
        const manifestBytes = metadata.get(OciArchive.pathFor(descriptor.digest));
        if (!manifestBytes || manifestBytes.byteLength !== descriptor.size) {
            throw new Error('Docker image archive is missing its OCI manifest');
        }
        const manifest = OciArchive.parseManifest(manifestBytes);
        return {
            manifest: manifestBytes,
            mediaType: descriptor.mediaType || manifest.mediaType || manifestMediaType,
            blobs: OciArchive.unique([manifest.config, ...manifest.layers]),
        };
    }

    async visit(visitor: (entry: Entry) => Promise<void>): Promise<void> {
        const archive = extract();
        createReadStream(this.path).pipe(archive);
        for await (const entry of archive) {
            if (entry.header.type && entry.header.type !== 'file') {
                entry.resume();
                continue;
            }
            await visitor(entry);
        }
    }

    static digestFromPath(path: string): string | undefined {
        const match = /^blobs\/sha256\/([0-9a-f]{64})$/.exec(path);
        return match?.[1] ? `sha256:${match[1]}` : undefined;
    }

    private static async readEntry(
        entry: AsyncIterable<Uint8Array>
    ): Promise<Uint8Array> {
        const parts: Uint8Array[] = [];
        let size = 0;
        for await (const part of entry) {
            size += part.byteLength;
            if (size > metadataLimit) {
                throw new Error('OCI archive metadata is too large');
            }
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

    private static parseIndex(value: Uint8Array | undefined): OciIndex {
        const parsed = OciArchive.parseJson(
            value,
            'Docker image archive does not contain index.json'
        );
        if (
            !OciArchive.isRecord(parsed) ||
            parsed.schemaVersion !== 2 ||
            !Array.isArray(parsed.manifests) ||
            !parsed.manifests.every(OciArchive.isDescriptor)
        ) {
            throw new Error('Docker image archive contains an invalid OCI index');
        }
        return { schemaVersion: 2, manifests: parsed.manifests };
    }

    private static parseManifest(value: Uint8Array): OciManifest {
        const parsed = OciArchive.parseJson(value, 'OCI manifest is not valid JSON');
        if (
            !OciArchive.isRecord(parsed) ||
            parsed.schemaVersion !== 2 ||
            !OciArchive.isDescriptor(parsed.config) ||
            !Array.isArray(parsed.layers) ||
            !parsed.layers.every(OciArchive.isDescriptor) ||
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

    private static parseJson(value: Uint8Array | undefined, message: string): unknown {
        if (!value) throw new Error(message);
        try {
            return JSON.parse(new TextDecoder().decode(value));
        } catch {
            throw new Error(message);
        }
    }

    private static isDescriptor(value: unknown): value is OciDescriptor {
        return (
            OciArchive.isRecord(value) &&
            typeof value.mediaType === 'string' &&
            typeof value.digest === 'string' &&
            /^sha256:[0-9a-f]{64}$/.test(value.digest) &&
            Number.isSafeInteger(value.size) &&
            typeof value.size === 'number' &&
            value.size >= 0
        );
    }

    private static unique(values: OciDescriptor[]): OciDescriptor[] {
        return [...new Map(values.map((value) => [value.digest, value])).values()];
    }

    private static pathFor(digest: string): string {
        return `blobs/sha256/${digest.slice('sha256:'.length)}`;
    }

    private static isRecord(value: unknown): value is Record<string, unknown> {
        return typeof value === 'object' && value !== null && !Array.isArray(value);
    }
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
