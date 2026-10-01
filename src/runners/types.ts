/**
 * The file operations a runner adapter needs to stage host-side assets: skills,
 * native configuration, and instruction files. Adapters depend on this interface
 * instead of a local filesystem so a host can back it with any storage.
 * `files/disk.ts` implements it over the local disk and `files/memory.ts` in
 * memory.
 */
export interface RunnerFiles {
    /** Reads a file as bytes. */
    readFile(path: string): Promise<Uint8Array>;
    /**
     * Writes a file. `exclusive` fails when the path already exists. `mode` is a
     * POSIX permission mask and is best effort on storage without one.
     */
    writeFile(
        path: string,
        data: string | Uint8Array,
        options?: { mode?: number; exclusive?: boolean }
    ): Promise<void>;
    /** Creates a directory. Without `recursive`, an existing directory is an error. */
    mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
    /** Lists the entry names directly inside a directory. */
    list(path: string): Promise<string[]>;
    /**
     * Describes a path without following a final symbolic link, or returns
     * `undefined` when nothing exists there.
     */
    lstat(path: string): Promise<RunnerFileStat | undefined>;
    /**
     * Describes a path, following symbolic links, or returns `undefined` when
     * nothing exists there.
     */
    stat(path: string): Promise<RunnerFileStat | undefined>;
    /** Creates a symbolic link at `path` pointing at `target`. */
    symlink(target: string, path: string): Promise<void>;
    /** Creates a fresh private temporary directory and returns its path. */
    tempDirectory(prefix: string): Promise<string>;
    /** Copies a file or a directory tree. Timestamps are preserved when possible. */
    copy(from: string, to: string): Promise<void>;
    /** Changes permission bits, where the storage has them. */
    chmod(path: string, mode: number): Promise<void>;
    /** Removes a file or directory tree. A missing path is not an error. */
    remove(path: string): Promise<void>;
}

export interface RunnerFileStat {
    kind: 'file' | 'directory' | 'symlink' | 'other';
    size: number;
}
