/**
 * Values shorter than this are never redacted. A short value such as `true`
 * or `1234` appears in ordinary text. workbenches.dev applies the same rule.
 */
const minimumLength = 8;

/**
 * Redacts credentials in paths, manifest fields, and messages, including the
 * form each value takes inside a JSON string. File bytes remain unchanged.
 */
export class WorkerOutcomeRedaction {
    private readonly values: Buffer[];

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
    }

    text(source: string): string {
        return this.replace(Buffer.from(source)).toString();
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

    private replace(source: Buffer): Buffer {
        const output = Buffer.alloc(source.length);
        const end = source.length;
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
        return output;
    }
}
