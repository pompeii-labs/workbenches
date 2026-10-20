/** A server an agent asked the engine to show the user. */
export interface PreviewAnnouncement {
    name: string;
    port: number;
}

export type PreviewDecision =
    | { accepted: true; preview: PreviewAnnouncement }
    | { accepted: false; reason: string };

/**
 * Decides which preview announcements a run may publish. The control file is
 * writable by the agent, so every line is untrusted: names are short slugs,
 * ports are unprivileged and never one the engine listens on itself, and a run
 * shows a bounded number of previews. A rejection reason never repeats the
 * announced text.
 */
export class PreviewPolicy {
    static readonly maximumPreviews = 8;
    static readonly maximumLineBytes = 512;
    static readonly minimumPort = 1024;
    static readonly maximumPort = 65_535;
    static readonly namePattern = /^[a-z0-9][a-z0-9-]{0,39}$/;

    constructor(private readonly reserved: () => Iterable<number>) {}

    /** Validates one announcement line against the current previews, keyed by name. */
    decide(line: string, current: ReadonlyMap<string, number>): PreviewDecision {
        if (new TextEncoder().encode(line).byteLength > PreviewPolicy.maximumLineBytes)
            return rejected('the announcement is too long');
        const parsed = parseLine(line);
        if (!parsed) return rejected('the announcement is not a JSON object');
        const { name, port } = parsed;
        if (typeof name !== 'string' || !PreviewPolicy.namePattern.test(name))
            return rejected(
                'the name must be 1 to 40 lowercase letters, digits, or hyphens and start with a letter or digit'
            );
        if (
            typeof port !== 'number' ||
            !Number.isInteger(port) ||
            port < PreviewPolicy.minimumPort ||
            port > PreviewPolicy.maximumPort
        )
            return rejected(
                `the port of ${name} must be an integer from ${PreviewPolicy.minimumPort} to ${PreviewPolicy.maximumPort}`
            );
        if (new Set(this.reserved()).has(port))
            return rejected(`port ${port} of ${name} is reserved by the engine`);
        if (!current.has(name) && current.size >= PreviewPolicy.maximumPreviews)
            return rejected(
                `${name} exceeds the limit of ${PreviewPolicy.maximumPreviews} previews per run`
            );
        return { accepted: true, preview: { name, port } };
    }
}

function rejected(reason: string): PreviewDecision {
    return { accepted: false, reason };
}

function parseLine(line: string): { name: unknown; port: unknown } | undefined {
    let value: unknown;
    try {
        value = JSON.parse(line);
    } catch {
        return undefined;
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        return undefined;
    return {
        name: 'name' in value ? value.name : undefined,
        port: 'port' in value ? value.port : undefined,
    };
}
