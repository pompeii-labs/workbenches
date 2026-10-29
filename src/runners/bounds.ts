/** The largest serialized `input` an event carries, in UTF-8 bytes. */
export const MAXIMUM_INPUT_BYTES = 16_384;
/** The largest `output` an event carries before its middle is removed, in UTF-8 bytes. */
export const MAXIMUM_OUTPUT_BYTES = 16_384;
/** The largest `patch` an event carries, in UTF-8 bytes. */
export const MAXIMUM_PATCH_BYTES = 65_536;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function byteLength(text: string): number {
    return encoder.encode(text).length;
}

/** The longest start of `text` within `limit` bytes, never splitting a character. */
export function headBytes(text: string, limit: number): string {
    const bytes = encoder.encode(text);
    if (bytes.length <= limit) return text;
    let end = Math.max(0, limit);
    while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
    return decoder.decode(bytes.subarray(0, end));
}

/** The longest end of `text` within `limit` bytes, never splitting a character. */
export function tailBytes(text: string, limit: number): string {
    const bytes = encoder.encode(text);
    if (bytes.length <= limit) return text;
    let start = bytes.length - Math.max(0, limit);
    while (start < bytes.length && ((bytes[start] ?? 0) & 0xc0) === 0x80) start++;
    return decoder.decode(bytes.subarray(start));
}

/**
 * Tool output within its cap: the first and last half, joined by a line that
 * says how many bytes between them were removed.
 */
export function boundOutput(text: string): { text: string; truncated: boolean } {
    const total = byteLength(text);
    if (total <= MAXIMUM_OUTPUT_BYTES) return { text, truncated: false };
    const head = headBytes(text, MAXIMUM_OUTPUT_BYTES / 2);
    const tail = tailBytes(text, MAXIMUM_OUTPUT_BYTES / 2);
    const removed = total - byteLength(head) - byteLength(tail);
    return {
        text: `${head}\n…[${removed} bytes truncated]…\n${tail}`,
        truncated: true,
    };
}

interface Leaf {
    container: Record<string, unknown> | unknown[];
    key: string | number;
    original: string;
    bytes: number;
    kept: number;
}

/**
 * Tool input whose serialization fits its cap: the longest strings are cut
 * first, each keeping its start and saying how many bytes it lost, until the
 * whole fits or nothing is left to cut.
 */
export function boundInput(input: Record<string, unknown>): {
    input: Record<string, unknown>;
    truncated: boolean;
} {
    if (byteLength(JSON.stringify(input)) <= MAXIMUM_INPUT_BYTES) {
        return { input, truncated: false };
    }
    const copy = structuredClone(input);
    const leaves: Leaf[] = [];
    collect(copy, leaves);
    let size = byteLength(JSON.stringify(copy));
    while (size > MAXIMUM_INPUT_BYTES) {
        const leaf = leaves.reduce<Leaf | undefined>(
            (longest, candidate) =>
                candidate.kept > 0 &&
                (!longest || rendered(candidate) > rendered(longest))
                    ? candidate
                    : longest,
            undefined
        );
        if (!leaf) break;
        leaf.kept = Math.max(0, leaf.kept - (size - MAXIMUM_INPUT_BYTES) - 32);
        const head = headBytes(leaf.original, leaf.kept);
        leaf.kept = byteLength(head);
        setLeaf(leaf, `${head}…[${leaf.bytes - leaf.kept} bytes truncated]`);
        size = byteLength(JSON.stringify(copy));
    }
    return { input: copy, truncated: true };
}

function rendered(leaf: Leaf): number {
    return leaf.kept === leaf.bytes ? leaf.bytes : leaf.kept + 24;
}

function setLeaf(leaf: Leaf, value: string): void {
    if (Array.isArray(leaf.container) && typeof leaf.key === 'number') {
        leaf.container[leaf.key] = value;
    } else if (!Array.isArray(leaf.container)) {
        leaf.container[String(leaf.key)] = value;
    }
}

function collect(value: unknown, leaves: Leaf[]): void {
    if (Array.isArray(value)) {
        value.forEach((item, index) => {
            if (typeof item === 'string') leaves.push(leaf(value, index, item));
            else collect(item, leaves);
        });
    } else if (isRecord(value)) {
        for (const [key, item] of Object.entries(value)) {
            if (typeof item === 'string') leaves.push(leaf(value, key, item));
            else collect(item, leaves);
        }
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function leaf(
    container: Record<string, unknown> | unknown[],
    key: string | number,
    original: string
): Leaf {
    const bytes = byteLength(original);
    return { container, key, original, bytes, kept: bytes };
}

/**
 * A patch within its cap, cut after the last whole hunk that fits, or at a
 * line boundary when not even the first hunk fits.
 */
export function boundPatch(patch: string): { patch: string; truncated: boolean } {
    if (byteLength(patch) <= MAXIMUM_PATCH_BYTES) return { patch, truncated: false };
    const lines = patch.split(/(?<=\n)/u);
    let kept = '';
    let size = 0;
    let lastHunkEnd = 0;
    for (const line of lines) {
        const lineBytes = byteLength(line);
        if (line.startsWith('@@')) lastHunkEnd = kept.length;
        if (size + lineBytes > MAXIMUM_PATCH_BYTES) break;
        kept += line;
        size += lineBytes;
    }
    const headerEnd = kept.indexOf('\n@@');
    const cut =
        lastHunkEnd > headerEnd + 1 && headerEnd >= 0 ? lastHunkEnd : kept.length;
    return { patch: kept.slice(0, cut), truncated: true };
}
