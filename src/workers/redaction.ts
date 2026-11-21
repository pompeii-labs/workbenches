import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';

/**
 * Values shorter than this are never redacted. A short value such as `true`
 * or `1234` appears in ordinary output, and replacing it would corrupt files
 * without protecting anything. workbenches.dev applies the same rule.
 */
const minimumLength = 8;

/**
 * Replaces credential bytes before part boundaries are chosen: each value
 * exactly, and the form it takes inside a JSON string, because tools often
 * print serialized JSON.
 */
export class WorkerOutcomeRedaction {
    private readonly values: Buffer[];
    private readonly retained: number;

    constructor(credentials: string[]) {
        this.values = [
            ...new Set(
                credentials
                    .filter((value) => value.length >= minimumLength)
                    .flatMap((value) => [value, JSON.stringify(value).slice(1, -1)])
            ),
        ]
            .map((value) => Buffer.from(value))
            .sort((left, right) => right.length - left.length);
        this.retained = Math.max(1, ...this.values.map((value) => value.length)) - 1;
    }

    async write(
        source: string,
        target: string
    ): Promise<{ size: number; sha256: string }> {
        const hash = createHash('sha256');
        let size = 0;
        const transform = this;
        await pipeline(
            createReadStream(source, { highWaterMark: 64 * 1024 }),
            async function* (chunks) {
                let pending = Buffer.alloc(0);
                for await (const chunk of chunks) {
                    const bytes = Buffer.concat([pending, Buffer.from(chunk)]);
                    const result = transform.replace(bytes, false);
                    pending = bytes.subarray(result.consumed);
                    hash.update(result.bytes);
                    size += result.bytes.length;
                    yield result.bytes;
                }
                const result = transform.replace(pending, true);
                hash.update(result.bytes);
                size += result.bytes.length;
                yield result.bytes;
            },
            createWriteStream(target, { mode: 0o600, flags: 'wx' })
        );
        return { size, sha256: hash.digest('hex') };
    }

    text(source: string): string {
        return this.replace(Buffer.from(source), true).bytes.toString();
    }

    value(source: unknown): unknown {
        if (typeof source === 'string') return this.text(source);
        if (Array.isArray(source))
            return source.map((entry: unknown) => this.value(entry));
        if (source !== null && typeof source === 'object')
            return Object.fromEntries(
                Object.entries(source).map(([key, value]: [string, unknown]) => [
                    this.text(key),
                    this.value(value),
                ])
            );
        return source;
    }

    private replace(
        source: Buffer,
        final: boolean
    ): { bytes: Buffer; consumed: number } {
        const output = Buffer.alloc(source.length);
        const end = final ? source.length : Math.max(0, source.length - this.retained);
        let offset = 0;
        while (offset < end) {
            let position = end;
            let match: Buffer | undefined;
            for (const candidate of this.values) {
                const index = source.indexOf(candidate, offset);
                if (index >= offset && index < position) {
                    position = index;
                    match = candidate;
                }
            }
            source.copy(output, offset, offset, position);
            offset = position;
            if (!match) break;
            const marker = Buffer.from('[redacted]'.padEnd(match.length, '*'));
            marker.copy(output, offset, 0, match.length);
            offset += match.length;
        }
        return { bytes: output.subarray(0, offset), consumed: offset };
    }
}
