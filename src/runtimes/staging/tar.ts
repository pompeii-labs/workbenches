/**
 * Tar and gzip over byte arrays, with no Node stream or zlib. Gzip uses the Web
 * Compression Streams API, which every current JavaScript runtime provides.
 * Reading accepts what GNU tar writes: ustar headers, GNU long names, and pax
 * extended headers. Writing emits ustar, with a pax header for a name or link
 * too long for one.
 */

export type TarEntryType = 'file' | 'directory' | 'symlink';

export interface TarEntry {
    name: string;
    type: TarEntryType;
    mode: number;
    /** File content. Empty for directories and links. */
    content: Uint8Array;
    /** Link target for a symlink. */
    link?: string;
}

const block = 512;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Packs entries into an uncompressed tar, including its end-of-archive blocks. */
export function packTar(entries: Iterable<TarEntry>): Uint8Array {
    const chunks: Uint8Array[] = [];
    for (const entry of entries) chunks.push(...entryBlocks(entry));
    chunks.push(new Uint8Array(block * 2));
    return concatenate(chunks);
}

function entryBlocks(entry: TarEntry): Uint8Array[] {
    const name = encoder.encode(entry.name);
    const link = entry.link === undefined ? undefined : encoder.encode(entry.link);
    const size = entry.type === 'file' ? entry.content.byteLength : 0;
    const records: Record<string, string> = {};
    if (name.byteLength > 100) records.path = entry.name;
    if (link && link.byteLength > 100) records.linkpath = entry.link ?? '';
    if (size > 0o77777777777) records.size = String(size);
    const blocks: Uint8Array[] = [];
    if (Object.keys(records).length > 0) {
        const body = paxBody(records);
        blocks.push(
            header({
                name: `PaxHeader/${entry.name.slice(0, 80)}`,
                mode: 0o644,
                size: body.byteLength,
                type: 'x',
            }),
            ...padded(body)
        );
    }
    blocks.push(
        header({
            name: name.byteLength > 100 ? entry.name.slice(0, 100) : entry.name,
            mode: entry.mode & 0o7777,
            size: Math.min(size, 0o77777777777),
            type:
                entry.type === 'directory' ? '5' : entry.type === 'symlink' ? '2' : '0',
            link: link && link.byteLength <= 100 ? entry.link : undefined,
        })
    );
    if (size > 0) blocks.push(...padded(entry.content));
    return blocks;
}

function paxBody(records: Record<string, string>): Uint8Array {
    const parts: Uint8Array[] = [];
    for (const [key, value] of Object.entries(records)) {
        const body = encoder.encode(` ${key}=${value}\n`);
        // The length counts its own digits.
        let length = body.byteLength + String(body.byteLength).length;
        if (String(length).length !== String(body.byteLength).length) length += 1;
        parts.push(encoder.encode(`${length}`), body);
    }
    return concatenate(parts);
}

function header(fields: {
    name: string;
    mode: number;
    size: number;
    type: string;
    link?: string | undefined;
}): Uint8Array {
    const out = new Uint8Array(block);
    const put = (offset: number, length: number, value: string) => {
        const bytes = encoder.encode(value);
        out.set(bytes.subarray(0, length), offset);
    };
    const octal = (offset: number, length: number, value: number) =>
        put(offset, length, `${value.toString(8).padStart(length - 1, '0')}\0`);
    put(0, 100, fields.name);
    octal(100, 8, fields.mode);
    octal(108, 8, 0);
    octal(116, 8, 0);
    octal(124, 12, fields.size);
    octal(136, 12, Math.floor(Date.now() / 1000));
    out.fill(0x20, 148, 156);
    put(156, 1, fields.type);
    if (fields.link) put(157, 100, fields.link);
    put(257, 6, 'ustar\0');
    put(263, 2, '00');
    let sum = 0;
    for (const byte of out) sum += byte;
    put(148, 8, `${sum.toString(8).padStart(6, '0')}\0 `);
    return out;
}

function padded(content: Uint8Array): Uint8Array[] {
    const remainder = content.byteLength % block;
    return remainder === 0 ? [content] : [content, new Uint8Array(block - remainder)];
}

export interface ReadTarOptions {
    /** Refuses an archive whose file contents add up to more than this. */
    maximumBytes?: number;
    /** Message for an archive past `maximumBytes`. */
    limitMessage?: () => string;
}

/**
 * Parses an uncompressed tar. Hard links, devices, and other entry types are
 * refused. Sizes are summed as headers are read, so a limit applies before any
 * content is copied.
 */
export function readTar(archive: Uint8Array, options: ReadTarOptions = {}): TarEntry[] {
    const entries: TarEntry[] = [];
    let offset = 0;
    let longName: string | undefined;
    let longLink: string | undefined;
    let pax: Record<string, string> = {};
    let total = 0;
    while (offset + block <= archive.byteLength) {
        const raw = archive.subarray(offset, offset + block);
        if (raw.every((byte) => byte === 0)) break;
        verifyChecksum(raw);
        const type = String.fromCharCode(raw[156] ?? 0x30);
        const size = parseSize(raw.subarray(124, 136));
        const bodyStart = offset + block;
        const bodyEnd = bodyStart + size;
        if (bodyEnd > archive.byteLength) throw new Error('Tar archive is truncated');
        const body = archive.subarray(bodyStart, bodyEnd);
        offset = bodyStart + Math.ceil(size / block) * block;
        if (type === 'L') {
            longName = text(body);
            continue;
        }
        if (type === 'K') {
            longLink = text(body);
            continue;
        }
        if (type === 'x') {
            pax = { ...pax, ...parsePax(body) };
            continue;
        }
        if (type === 'g') continue;
        const name = pax.path ?? longName ?? entryName(raw);
        const link = pax.linkpath ?? longLink ?? field(raw, 157, 100);
        const actualSize = pax.size === undefined ? size : Number(pax.size);
        const mode = parseSize(raw.subarray(100, 108)) & 0o7777;
        longName = undefined;
        longLink = undefined;
        pax = {};
        if (type === '0' || type === '\0' || type === '7') {
            total += actualSize;
            if (options.maximumBytes !== undefined && total > options.maximumBytes) {
                throw new Error(
                    options.limitMessage?.() ?? 'Tar archive exceeds its size limit'
                );
            }
            entries.push({
                name,
                type: 'file',
                mode,
                content: body.slice(0, actualSize),
            });
        } else if (type === '5') {
            entries.push({ name, type: 'directory', mode, content: new Uint8Array() });
        } else if (type === '2') {
            entries.push({
                name,
                type: 'symlink',
                mode,
                content: new Uint8Array(),
                link,
            });
        } else {
            throw new Error(
                `Unsupported tar entry type ${JSON.stringify(type)}: ${name}`
            );
        }
    }
    return entries;
}

function entryName(raw: Uint8Array): string {
    const name = field(raw, 0, 100);
    const prefix = raw
        .subarray(257, 262)
        .every((byte, index) => byte === 'ustar'.charCodeAt(index))
        ? field(raw, 345, 155)
        : '';
    return prefix ? `${prefix}/${name}` : name;
}

function field(raw: Uint8Array, start: number, length: number): string {
    const bytes = raw.subarray(start, start + length);
    const end = bytes.indexOf(0);
    return decoder.decode(end === -1 ? bytes : bytes.subarray(0, end));
}

function text(body: Uint8Array): string {
    const end = body.indexOf(0);
    return decoder.decode(end === -1 ? body : body.subarray(0, end));
}

function parseSize(bytes: Uint8Array): number {
    // GNU tar stores a size too large for octal as base-256 with the top bit set.
    if ((bytes[0] ?? 0) & 0x80) {
        let value = (bytes[0] ?? 0) & 0x7f;
        for (let index = 1; index < bytes.length; index++) {
            value = value * 256 + (bytes[index] ?? 0);
        }
        if (!Number.isSafeInteger(value)) throw new Error('Tar entry is too large');
        return value;
    }
    const digits = decoder.decode(bytes).replace(/\0.*$/s, '').trim();
    if (!digits) return 0;
    if (!/^[0-7]+$/.test(digits)) throw new Error('Tar header is invalid');
    return Number.parseInt(digits, 8);
}

function parsePax(body: Uint8Array): Record<string, string> {
    const records: Record<string, string> = {};
    let offset = 0;
    while (offset < body.byteLength) {
        const space = body.indexOf(0x20, offset);
        if (space === -1) break;
        const length = Number(decoder.decode(body.subarray(offset, space)));
        if (!Number.isInteger(length) || length <= 0) {
            throw new Error('Tar pax header is invalid');
        }
        const record = decoder.decode(body.subarray(space + 1, offset + length - 1));
        const equals = record.indexOf('=');
        if (equals > 0) records[record.slice(0, equals)] = record.slice(equals + 1);
        offset += length;
    }
    return records;
}

function verifyChecksum(raw: Uint8Array): void {
    let sum = 0;
    for (let index = 0; index < block; index++) {
        sum += index >= 148 && index < 156 ? 0x20 : (raw[index] ?? 0);
    }
    const stored = Number.parseInt(field(raw, 148, 8).trim() || '0', 8);
    if (sum !== stored) throw new Error('Tar header checksum does not match');
}

function concatenate(chunks: Uint8Array[]): Uint8Array {
    const out = new Uint8Array(
        chunks.reduce((total, chunk) => total + chunk.byteLength, 0)
    );
    let offset = 0;
    for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return out;
}

/** Compresses bytes with gzip. */
export async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
    return collect(
        new Blob([bytes as Uint8Array<ArrayBuffer>])
            .stream()
            .pipeThrough(new CompressionStream('gzip'))
    );
}

/**
 * Decompresses gzip bytes, stopping as soon as the output passes
 * `maximumBytes` so a small input cannot expand without bound.
 */
export async function gunzip(
    bytes: Uint8Array,
    maximumBytes = Number.POSITIVE_INFINITY,
    limitMessage = () => 'Compressed data exceeds its size limit'
): Promise<Uint8Array> {
    const stream = new Blob([bytes as Uint8Array<ArrayBuffer>])
        .stream()
        .pipeThrough(new DecompressionStream('gzip'));
    return collect(stream, maximumBytes, limitMessage);
}

async function collect(
    stream: ReadableStream<Uint8Array>,
    maximumBytes = Number.POSITIVE_INFINITY,
    limitMessage = () => 'Data exceeds its size limit'
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
            throw new Error(limitMessage());
        }
        chunks.push(next.value);
    }
    return concatenate(chunks);
}

/** Packs entries into a gzip tar, the format a sandbox unpacks with `tar -xzf`. */
export async function packTarGzip(entries: Iterable<TarEntry>): Promise<Uint8Array> {
    return gzip(packTar(entries));
}
