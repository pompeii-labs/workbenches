import type { AssetSource, AssetStat } from './source.js';

type MemoryEntry =
    | { kind: 'file'; content: Uint8Array; mode: number }
    | { kind: 'directory'; mode: number }
    | { kind: 'symlink'; link: string; mode: number };

/**
 * An `AssetSource` over files held in memory, for tests and for hosts that have
 * no filesystem. Paths are absolute and virtual: the source never consults a
 * disk, and a workspace or package directory is whatever paths you add. It has
 * no Git awareness, so workspaces are staged by walking their files.
 */
export class MemoryAssetSource implements AssetSource {
    private readonly entries = new Map<string, MemoryEntry>();
    /** The paths read so far, in order. */
    readonly reads: string[] = [];

    /** Adds a file and the directories above it. */
    file(path: string, content: string | Uint8Array, mode = 0o644): this {
        this.directories(path);
        this.entries.set(path, {
            kind: 'file',
            content:
                typeof content === 'string'
                    ? new TextEncoder().encode(content)
                    : content,
            mode,
        });
        return this;
    }

    /** Adds a symbolic link and the directories above it. */
    link(path: string, target: string): this {
        this.directories(path);
        this.entries.set(path, { kind: 'symlink', link: target, mode: 0o777 });
        return this;
    }

    /** Adds an empty directory and the directories above it. */
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

    async stat(path: string): Promise<AssetStat | undefined> {
        return this.describe(path);
    }

    async lstat(path: string): Promise<AssetStat | undefined> {
        return this.describe(path);
    }

    async list(path: string): Promise<string[]> {
        const prefix = `${path.replace(/\/$/, '')}/`;
        return [...this.entries.keys()]
            .filter(
                (key) =>
                    key.startsWith(prefix) && !key.slice(prefix.length).includes('/')
            )
            .map((key) => key.slice(prefix.length));
    }

    async readLink(path: string): Promise<string> {
        const entry = this.entries.get(path);
        if (entry?.kind !== 'symlink') throw new Error(`Not a link: ${path}`);
        return entry.link;
    }

    async read(path: string): Promise<Uint8Array> {
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
