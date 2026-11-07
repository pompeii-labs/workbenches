const MAXIMUM_LINE_LENGTH = 16 * 1024 * 1024;
const encoder = new TextEncoder();

/**
 * Reads newline-delimited output, handing each line to `consume` without its
 * line ending, with the UTF-8 bytes it took in the stream. A final line without
 * a newline is consumed only when it holds text.
 */
export async function readLines(
    reader: { read(): Promise<{ done: boolean; value?: Uint8Array | undefined }> },
    consume: (line: string, bytes: number) => Promise<void>,
    oversized: string
): Promise<void> {
    const decoder = new TextDecoder();
    let pending = '';
    for (;;) {
        const next = await reader.read();
        if (next.done) break;
        pending += decoder.decode(next.value, { stream: true });
        if (pending.length > MAXIMUM_LINE_LENGTH) throw new Error(oversized);
        const lines = pending.split('\n');
        pending = lines.pop() ?? '';
        for (const line of lines) {
            const normalized = line.endsWith('\r') ? line.slice(0, -1) : line;
            await consume(normalized, encoder.encode(`${line}\n`).byteLength);
        }
    }
    pending += decoder.decode();
    if (pending.trim()) await consume(pending, encoder.encode(pending).byteLength);
}
