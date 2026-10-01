/**
 * Where a provider reads the files it copies into a sandbox. The CLI passes the
 * local disk (`disk.ts`); a host can pass any store that can list and read
 * files. Paths are absolute paths in the source's own namespace.
 */
export interface AssetStat {
    kind: 'file' | 'directory' | 'symlink' | 'other';
    size: number;
    /** POSIX permission bits. */
    mode: number;
}

export interface AssetSource {
    /** Describes a path, following a final symbolic link. `undefined` if missing. */
    stat(path: string): Promise<AssetStat | undefined>;
    /** Describes a path without following a final symbolic link. */
    lstat(path: string): Promise<AssetStat | undefined>;
    /** Lists the entry names directly inside a directory. */
    list(path: string): Promise<string[]>;
    readLink(path: string): Promise<string>;
    /** Reads a whole file. */
    read(path: string): Promise<Uint8Array>;
    /**
     * Optional Git awareness. With it, a workspace that is a Git repository is
     * staged as its tracked and unignored files, exactly as a developer would see
     * it. Without it, every workspace is staged by walking its files.
     */
    git?: AssetGit;
}

export interface AssetGit {
    /** Tracked and untracked-but-unignored files, relative. `undefined` if not a repository. */
    files(root: string): Promise<string[] | undefined>;
    /** Whether a relative path is tracked. */
    tracked(root: string, path: string): Promise<boolean>;
    /** The checked-out commit, if any. */
    revision(root: string): Promise<string | undefined>;
}
