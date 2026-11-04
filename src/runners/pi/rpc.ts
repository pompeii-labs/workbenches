/** Consumes Pi's JSONL stream without retaining partial events indefinitely. */
export async function consumeLines(
    stream: ReadableStream<Uint8Array> | undefined,
    consume: (line: string) => Promise<void>
): Promise<void> {
    if (!stream) return;
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    for (;;) {
        const next = await reader.read();
        if (next.done) break;
        pending += decoder.decode(next.value, { stream: true });
        if (pending.length > 16 * 1024 * 1024) {
            throw new Error('Pi RPC emitted an oversized JSON event');
        }
        const lines = pending.split('\n');
        pending = lines.pop() ?? '';
        for (const line of lines) {
            const normalized = line.endsWith('\r') ? line.slice(0, -1) : line;
            if (normalized.trim()) await consume(normalized);
        }
    }
    pending += decoder.decode();
    if (pending.trim()) await consume(pending);
}

export async function readLimitedText(
    stream: ReadableStream<Uint8Array> | undefined,
    limit: number
): Promise<string> {
    if (!stream) return '';
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let output = '';
    for (;;) {
        const next = await reader.read();
        if (next.done) break;
        if (output.length < limit) output += decoder.decode(next.value);
    }
    return output.slice(0, limit);
}

export async function withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    message: string
): Promise<T> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<T>((_, reject) => {
                timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
            }),
        ]);
    } finally {
        if (timeout) clearTimeout(timeout);
    }
}

export function record(value: unknown): Record<string, unknown> | undefined {
    return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function string(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function asError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}
