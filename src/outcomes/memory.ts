import type { OutcomeSink } from './collection.js';
import type { OutcomeContentDescriptor, OutcomeDigest } from './contracts.js';

export interface MemoryOutcomeStoreOptions {
    /** Refuses a single blob larger than this. Unlimited by default. */
    maximumContentBytes?: number;
}

/**
 * An `OutcomeSink` that keeps collected content in process memory, addressed by
 * SHA-256 digest like the disk store's blobs. It has no quota and no lease:
 * those protect a shared directory, and this store has none. It is for tests and
 * for hosts that copy collected content into their own storage.
 */
export class MemoryOutcomeStore implements OutcomeSink {
    private readonly blobs = new Map<
        OutcomeDigest,
        { bytes: Uint8Array; mediaType: string }
    >();

    constructor(private readonly options: MemoryOutcomeStoreOptions = {}) {}

    async putBytes(
        bytes: Uint8Array | string,
        mediaType: string
    ): Promise<OutcomeContentDescriptor> {
        const source =
            typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes;
        const maximum = this.options.maximumContentBytes;
        if (maximum !== undefined && source.byteLength > maximum) {
            throw new Error(
                `Outcome content exceeds the ${maximum} byte limit: ${source.byteLength} bytes`
            );
        }
        const digest = await sha256(source);
        if (!this.blobs.has(digest)) {
            this.blobs.set(digest, { bytes: source.slice(), mediaType });
        }
        return { digest, media_type: mediaType, size_bytes: source.byteLength };
    }

    /** The bytes stored for a descriptor. */
    get(descriptor: OutcomeContentDescriptor): Uint8Array {
        const blob = this.blobs.get(descriptor.digest);
        if (!blob || blob.bytes.byteLength !== descriptor.size_bytes) {
            throw new Error(`Outcome content is unavailable: ${descriptor.digest}`);
        }
        return blob.bytes.slice();
    }

    has(descriptor: OutcomeContentDescriptor): boolean {
        return (
            this.blobs.get(descriptor.digest)?.bytes.byteLength ===
            descriptor.size_bytes
        );
    }

    /** Digests of everything stored, in insertion order. */
    digests(): OutcomeDigest[] {
        return [...this.blobs.keys()];
    }
}

async function sha256(bytes: Uint8Array): Promise<OutcomeDigest> {
    const digest = await crypto.subtle.digest(
        'SHA-256',
        bytes as Uint8Array<ArrayBuffer>
    );
    return `sha256:${Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, '0')
    ).join('')}`;
}
