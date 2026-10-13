import { pathStyle } from '../../../platform/paths.js';

import type { TransferRules } from '../rules.js';
import type { AssetSource, AssetStat } from '../source.js';
import { TarArchive } from '../tar.js';

const maximumLinkHops = 40;

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
        path = pathStyle(path).normalize(path);
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
        path = pathStyle(path).normalize(path);
        this.directories(path);
        this.entries.set(path, { kind: 'symlink', link: target, mode: 0o777 });
        return this;
    }

    /** Adds an empty directory and the directories above it. */
    directory(path: string): this {
        path = pathStyle(path).normalize(path);
        this.directories(pathStyle(path).join(path, 'x'));
        return this;
    }

    /**
     * Adds the files of a gzip tar beneath `directory`, which is created even
     * when the archive is empty. This restores what a `NativeStateSink`
     * received, so the same directory can be staged as a `state` asset again.
     * Only regular files and directories are accepted, and every path must
     * stay beneath `directory`. `rules` names the provider in messages.
     */
    async unpack(
        directory: string,
        archive: Uint8Array,
        rules: TransferRules
    ): Promise<this> {
        const entries = (await TarArchive.gunzip(archive)).entries();
        this.directory(directory);
        for (const entry of entries) {
            const name = rules.normalizeArchivePath(entry.name).replace(/\/$/, '');
            if (entry.type === 'directory' && name === '') continue;
            rules.validateRelativePath(name);
            const path = posix.join(directory, name);
            if (entry.type === 'directory') this.directory(path);
            else if (entry.type === 'file') this.file(path, entry.content, entry.mode);
            else {
                throw new Error(
                    `${rules.provider} native state archive contains a link: ${name}`
                );
            }
        }
        return this;
    }

    private directories(path: string): void {
        const paths = pathStyle(path);
        let directory = paths.dirname(path);
        while (true) {
            if (!this.entries.has(directory))
                this.entries.set(directory, { kind: 'directory', mode: 0o755 });
            const parent = paths.dirname(directory);
            if (parent === directory || parent === '.') break;
            directory = parent;
        }
    }

    async stat(path: string): Promise<AssetStat | undefined> {
        path = pathStyle(path).normalize(path);
        // Follow a chain of final links. A cycle describes nothing, as ELOOP would.
        let current = path;
        for (let hops = 0; hops <= maximumLinkHops; hops++) {
            const entry = this.entries.get(current);
            if (entry?.kind !== 'symlink') return this.describe(current);
            const paths = pathStyle(current);
            current = paths.resolve(paths.dirname(current), entry.link);
        }
        return undefined;
    }

    async lstat(path: string): Promise<AssetStat | undefined> {
        path = pathStyle(path).normalize(path);
        return this.describe(path);
    }

    async list(path: string): Promise<string[]> {
        path = pathStyle(path).normalize(path);
        const separator = pathStyle(path).sep;
        const prefix = path.endsWith(separator) ? path : path + separator;
        return [...this.entries.keys()]
            .filter(
                (key) =>
                    key.startsWith(prefix) &&
                    !key.slice(prefix.length).includes(separator)
            )
            .map((key) => key.slice(prefix.length));
    }

    async readLink(path: string): Promise<string> {
        path = pathStyle(path).normalize(path);
        const entry = this.entries.get(path);
        if (entry?.kind !== 'symlink') throw new Error(`Not a link: ${path}`);
        return entry.link;
    }

    async read(path: string): Promise<Uint8Array> {
        path = pathStyle(path).normalize(path);
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
