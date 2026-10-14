/**
 * Reads a sandbox download into memory, stopping with `exceeded` as the error
 * message once it passes `maximumBytes`.
 */
export async function readBoundedBytes(
    stream: ReadableStream<Uint8Array>,
    maximumBytes: number,
    exceeded: string
): Promise<Uint8Array> {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
        const next = await reader.read();
        if (next.done) break;
        total += next.value.byteLength;
        if (total > maximumBytes) {
            await reader.cancel().catch(() => {});
            throw new Error(exceeded);
        }
        chunks.push(next.value);
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return out;
}
