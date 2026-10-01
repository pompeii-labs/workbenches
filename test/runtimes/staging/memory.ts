import { gunzipSync } from 'node:zlib';
import tar from 'tar-stream';

import type { AssetSource, AssetStat } from '../../../src/runtimes/staging/source.js';

type MemoryEntry =
    | { kind: 'file'; content: Uint8Array; mode: number }
    | { kind: 'directory'; mode: number }
    | { kind: 'symlink'; link: string; mode: number };

/** An asset source with no disk behind it. Paths are absolute and virtual. */
export class MemoryAssetSource implements AssetSource {
    private readonly entries = new Map<string, MemoryEntry>();
    readonly reads: string[] = [];

    file(path: string, content: string, mode = 0o644): this {
        this.directories(path);
        this.entries.set(path, {
            kind: 'file',
            content: new TextEncoder().encode(content),
            mode,
        });
        return this;
    }

    link(path: string, target: string): this {
        this.directories(path);
        this.entries.set(path, { kind: 'symlink', link: target, mode: 0o777 });
        return this;
    }

    directory(path: string): this {
        this.directories(`${path}/x`);
        return this;
    }

    private directories(path: string): void {
        const parts = path.split('/').filter(Boolean);
        for (let index = 1; index < parts.length; index++) {
            const directory = `/${parts.slice(0, index).join('/')}`;
            if (!this.entries.has(directory)) {
                this.entries.set(directory, { kind: 'directory', mode: 0o755 });
            }
        }
    }

    async stat(path: string) {
        return this.describe(path);
    }

    async lstat(path: string) {
        return this.describe(path);
    }

    async list(path: string) {
        const prefix = `${path.replace(/\/$/, '')}/`;
        return [...this.entries.keys()]
            .filter(
                (key) =>
                    key.startsWith(prefix) && !key.slice(prefix.length).includes('/')
            )
            .map((key) => key.slice(prefix.length));
    }

    async readLink(path: string) {
        const entry = this.entries.get(path);
        if (entry?.kind !== 'symlink') throw new Error(`Not a link: ${path}`);
        return entry.link;
    }

    async read(path: string) {
        this.reads.push(path);
        const entry = this.entries.get(path);
        if (entry?.kind !== 'file') throw new Error(`Not a file: ${path}`);
        return entry.content;
    }

    private describe(path: string): AssetStat | undefined {
        const entry = this.entries.get(path);
        if (!entry) return undefined;
        return {
            kind: entry.kind,
            size: entry.kind === 'file' ? entry.content.byteLength : 0,
            mode: entry.mode,
        };
    }
}

/** Lists the regular files and links in a gzip tar, with file text. */
export async function readArchive(
    bytes: Uint8Array
): Promise<Record<string, string | { link: string }>> {
    const extract = tar.extract();
    const result: Record<string, string | { link: string }> = {};
    extract.on('entry', (header, stream, next) => {
        const chunks: Buffer[] = [];
        stream.on('data', (chunk: Buffer) => chunks.push(chunk));
        stream.on('end', () => {
            result[header.name] =
                header.type === 'symlink'
                    ? { link: header.linkname ?? '' }
                    : Buffer.concat(chunks).toString('utf8');
            next();
        });
    });
    const finished = new Promise<void>((resolve, reject) => {
        extract.on('finish', resolve);
        extract.on('error', reject);
    });
    extract.end(gunzipSync(bytes));
    await finished;
    return result;
}
