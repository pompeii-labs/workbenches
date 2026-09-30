import type { AssetSource, AssetStat } from '../runtimes/staging/source.js';
import type { RunnerFileStat, RunnerFiles } from './files.js';

type Entry =
    | { kind: 'file'; content: Uint8Array; mode: number }
    | { kind: 'directory'; mode: number };

function fail(code: string, message: string): never {
    throw Object.assign(new Error(`${code}: ${message}`), { code });
}

/**
 * `RunnerFiles` over paths held in memory, for tests and for hosts with no
 * filesystem. Paths are absolute and virtual. Like a disk, it refuses to write
 * into a missing directory and to create one that exists, so staging code that
 * works here works against real storage. It has no symbolic links.
 *
 * It is also an `AssetSource`, so one store can hold a Workbench package, a
 * workspace, and the skills a runner stages, and serve a remote runtime and a
 * runner at once.
 */
export class MemoryRunnerFiles implements RunnerFiles, AssetSource {
    private readonly entries = new Map<string, Entry>([
        ['/', { kind: 'directory', mode: 0o755 }],
    ]);

    /** Adds a file with its directories, for arranging the files a test stages from. */
    file(path: string, content: string | Uint8Array, mode = 0o644): this {
        const target = normalize(path);
        this.directories(parent(target));
        this.entries.set(target, {
            kind: 'file',
            content:
                typeof content === 'string'
                    ? new TextEncoder().encode(content)
                    : content.slice(),
            mode,
        });
        return this;
    }

    /** Adds an empty directory and the directories above it. */
    directory(path: string): this {
        this.directories(normalize(path));
        return this;
    }

    /** The text of a file, for asserting what was staged. */
    text(path: string): string {
        const entry = this.entries.get(normalize(path));
        if (entry?.kind !== 'file') fail('ENOENT', `no such file: ${path}`);
        return new TextDecoder().decode(entry.content);
    }

    /** The permission bits of a file or directory. */
    mode(path: string): number {
        const entry = this.entries.get(normalize(path));
        if (!entry) fail('ENOENT', `no such file or directory: ${path}`);
        return entry.mode;
    }

    /** Every path held, sorted. */
    paths(): string[] {
        return [...this.entries.keys()].toSorted();
    }

    async readFile(path: string): Promise<Uint8Array> {
        const entry = this.entries.get(normalize(path));
        if (!entry) fail('ENOENT', `no such file: ${path}`);
        if (entry.kind !== 'file') fail('EISDIR', `is a directory: ${path}`);
        return entry.content.slice();
    }

    async writeFile(
        path: string,
        data: string | Uint8Array,
        options: { mode?: number; exclusive?: boolean } = {}
    ): Promise<void> {
        const target = normalize(path);
        const existing = this.entries.get(target);
        if (existing && options.exclusive) fail('EEXIST', `file exists: ${path}`);
        if (existing?.kind === 'directory') fail('EISDIR', `is a directory: ${path}`);
        if (this.entries.get(parent(target))?.kind !== 'directory') {
            fail('ENOENT', `no such directory: ${parent(target)}`);
        }
        this.entries.set(target, {
            kind: 'file',
            content:
                typeof data === 'string'
                    ? new TextEncoder().encode(data)
                    : data.slice(),
            mode: options.mode ?? existing?.mode ?? 0o644,
        });
    }

    async mkdir(path: string, options: { recursive?: boolean } = {}): Promise<void> {
        const target = normalize(path);
        if (options.recursive) {
            this.directories(target);
            return;
        }
        if (this.entries.has(target)) fail('EEXIST', `file exists: ${path}`);
        if (this.entries.get(parent(target))?.kind !== 'directory') {
            fail('ENOENT', `no such directory: ${parent(target)}`);
        }
        this.entries.set(target, { kind: 'directory', mode: 0o755 });
    }

    async list(path: string): Promise<string[]> {
        const target = normalize(path);
        if (this.entries.get(target)?.kind !== 'directory') {
            fail('ENOENT', `no such directory: ${path}`);
        }
        const prefix = target === '/' ? '/' : `${target}/`;
        return [...this.entries.keys()]
            .filter(
                (key) =>
                    key !== target &&
                    key.startsWith(prefix) &&
                    !key.slice(prefix.length).includes('/')
            )
            .map((key) => key.slice(prefix.length));
    }

    async stat(path: string): Promise<(RunnerFileStat & AssetStat) | undefined> {
        const entry = this.entries.get(normalize(path));
        if (!entry) return undefined;
        return {
            kind: entry.kind,
            size: entry.kind === 'file' ? entry.content.byteLength : 0,
            mode: entry.mode,
        };
    }

    /** As `stat`. There are no symbolic links, so nothing is followed either way. */
    lstat(path: string): Promise<(RunnerFileStat & AssetStat) | undefined> {
        return this.stat(path);
    }

    /** As `readFile`, under the name `AssetSource` uses. */
    read(path: string): Promise<Uint8Array> {
        return this.readFile(path);
    }

    async readLink(path: string): Promise<string> {
        fail('EINVAL', `not a symbolic link: ${path}`);
    }

    async tempDirectory(prefix: string): Promise<string> {
        const path = `/tmp/${prefix}${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
        this.directories(path);
        this.entries.set(path, { kind: 'directory', mode: 0o700 });
        return path;
    }

    async copy(from: string, to: string): Promise<void> {
        const source = normalize(from);
        const destination = normalize(to);
        const root = this.entries.get(source);
        if (!root) fail('ENOENT', `no such file or directory: ${from}`);
        this.directories(parent(destination));
        const prefix = `${source}/`;
        for (const [path, entry] of [...this.entries]) {
            if (path !== source && !path.startsWith(prefix)) continue;
            const target = `${destination}${path.slice(source.length)}`;
            this.entries.set(
                target,
                entry.kind === 'file'
                    ? { kind: 'file', content: entry.content.slice(), mode: entry.mode }
                    : { ...entry }
            );
        }
    }

    async chmod(path: string, mode: number): Promise<void> {
        const target = normalize(path);
        const entry = this.entries.get(target);
        if (!entry) fail('ENOENT', `no such file or directory: ${path}`);
        this.entries.set(target, { ...entry, mode });
    }

    async remove(path: string): Promise<void> {
        const target = normalize(path);
        if (target === '/') fail('EPERM', 'cannot remove the root');
        for (const key of [...this.entries.keys()]) {
            if (key === target || key.startsWith(`${target}/`))
                this.entries.delete(key);
        }
    }

    private directories(path: string): void {
        const parts = path.split('/').filter(Boolean);
        for (let index = 1; index <= parts.length; index++) {
            const directory = `/${parts.slice(0, index).join('/')}`;
            const existing = this.entries.get(directory);
            if (existing?.kind === 'file')
                fail('ENOTDIR', `not a directory: ${directory}`);
            if (!existing)
                this.entries.set(directory, { kind: 'directory', mode: 0o755 });
        }
    }
}

function normalize(path: string): string {
    const segments: string[] = [];
    for (const part of path.split('/')) {
        if (!part || part === '.') continue;
        if (part === '..') segments.pop();
        else segments.push(part);
    }
    return `/${segments.join('/')}`;
}

function parent(path: string): string {
    const index = path.lastIndexOf('/');
    return index <= 0 ? '/' : path.slice(0, index);
}
