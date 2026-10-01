import { dirname, join, resolve } from 'node:path';

import { WorkspaceProtection } from './protection.js';
import type { TransferRules } from './rules.js';
import type { AssetSource } from './source.js';
import { TarArchive, type TarEntry } from './tar.js';

export interface SnapshotEntry {
    path: string;
    type: 'file' | 'symlink';
    mode: number;
    digest?: string;
    link?: string;
    size: number;
}

export interface WalkOptions {
    /** Directory below `root` to start from, as a relative path. */
    prefix?: string;
    /** Skip paths that must never leave the host, recording them in `excludedPaths`. */
    protectWorkspace?: boolean;
    excludedPaths?: string[];
    syncExcludedPaths?: string[];
}

/**
 * A file whose body is still to be read. The writer digests it while copying it
 * into the archive and records the digest on `entry`.
 */
export interface StreamedRecord {
    type: 'stream';
    name: string;
    mode: number;
    size: number;
    body: ReadableStream<Uint8Array>;
    entry: SnapshotEntry;
}

/**
 * How a remote provider copies host paths into a transfer archive. It reads
 * files through an `AssetSource` and names the provider in its messages.
 */
export class TransferPlan {
    private readonly protection = new WorkspaceProtection();

    constructor(
        private readonly source: AssetSource,
        /** Which archive paths are safe, and the provider named in messages. */
        private readonly rules: TransferRules
    ) {}

    /**
     * Chooses the files to copy from a directory asset. A workspace that is a Git
     * repository contributes its tracked and unignored files when the source knows
     * Git. Everything else is walked. Protected and nested-asset paths are
     * recorded in `excludedPaths` rather than copied.
     */
    async selectPaths(
        binding: { hostPath: string; kind: string },
        excludedPaths: string[],
        syncExcludedPaths: string[]
    ): Promise<string[]> {
        const source = this.source;
        const listed =
            binding.kind === 'workspace'
                ? await source.git?.files(binding.hostPath)
                : undefined;
        if (!listed) {
            return this.walk(binding.hostPath, {
                protectWorkspace: true,
                excludedPaths,
                syncExcludedPaths,
            });
        }
        return this.selectListed(binding, listed, excludedPaths, syncExcludedPaths);
    }

    private async selectListed(
        binding: { hostPath: string },
        listed: string[],
        excludedPaths: string[],
        syncExcludedPaths: string[]
    ): Promise<string[]> {
        const source = this.source;
        const names = listed
            .map((path) => this.rules.normalizeArchivePath(path))
            .filter((path) => {
                // Git reports an untracked nested repository as one directory entry.
                // Expanding it would copy a second checkout, including agent worktrees.
                if (path.endsWith('/')) {
                    excludedPaths.push(path.slice(0, -1));
                    return false;
                }
                if (this.rules.excludedByNestedAsset(path, syncExcludedPaths))
                    return false;
                if (
                    !this.protection.protectedWorkspacePath(path) ||
                    this.protection.projectNpmrcPath(path)
                )
                    return true;
                excludedPaths.push(path);
                return false;
            });
        const expanded: string[] = [];
        for (const name of names) {
            const path = join(binding.hostPath, name);
            const details = await source.lstat(path);
            if (!details) continue;
            if (this.protection.projectNpmrcPath(name)) {
                if (!(await source.git?.tracked(binding.hostPath, name))) {
                    excludedPaths.push(name);
                    continue;
                }
                if (
                    details.kind !== 'file' ||
                    details.size > 64 * 1024 ||
                    !this.protection.safeProjectNpmrc(await source.read(path))
                ) {
                    throw new Error(
                        `Cannot safely transfer tracked project config ${name} to ${this.rules.provider}. Only non-secret npm boolean settings are supported; remove credentials or unsupported settings before retrying.`
                    );
                }
            }
            if (details.kind === 'directory') {
                // Ordinary files are listed individually. A directory here is a
                // Gitlink or another nested repository boundary, whose own ignore
                // rules and credential-bearing files are not part of this snapshot.
                excludedPaths.push(name);
            } else {
                expanded.push(name);
            }
        }
        return [...new Set(expanded)].toSorted();
    }

    async walk(root: string, options: WalkOptions = {}): Promise<string[]> {
        const {
            prefix = '',
            protectWorkspace = false,
            excludedPaths = [],
            syncExcludedPaths = [],
        } = options;
        const absolute = prefix ? resolve(root, prefix) : root;
        const entries = await this.source.list(absolute);
        const paths: string[] = [];
        for (const entry of entries.toSorted((left, right) =>
            left.localeCompare(right)
        )) {
            const name = this.rules.normalizeArchivePath(
                prefix ? `${prefix}/${entry}` : entry
            );
            if (this.rules.excludedByNestedAsset(name, syncExcludedPaths)) continue;
            if (protectWorkspace && this.protection.protectedWorkspacePath(name)) {
                excludedPaths.push(name);
                continue;
            }
            const details = await this.source.lstat(join(root, name));
            if (!details) continue;
            if (details.kind === 'directory') {
                paths.push(
                    ...(await this.walk(root, {
                        prefix: name,
                        protectWorkspace,
                        excludedPaths,
                        syncExcludedPaths,
                    }))
                );
            } else if (details.kind === 'file' || details.kind === 'symlink') {
                paths.push(name);
            }
        }
        return paths;
    }

    async describeEntries(
        root: string,
        paths: string[],
        symlinkRoot: string
    ): Promise<Map<string, SnapshotEntry>> {
        const entries = new Map<string, SnapshotEntry>();
        for (const path of paths.toSorted()) {
            this.rules.validateRelativePath(path);
            entries.set(
                path,
                await this.describeEntry(join(root, path), path, symlinkRoot)
            );
        }
        return entries;
    }

    async describeEntry(
        absolutePath: string,
        path: string,
        symlinkRoot: string
    ): Promise<SnapshotEntry> {
        const details = await this.source.lstat(absolutePath);
        if (!details) throw new Error(`Runtime asset does not exist: ${absolutePath}`);
        if (details.kind === 'symlink') {
            const link = await this.source.readLink(absolutePath);
            this.rules.validateSymlink({
                parent: dirname(absolutePath),
                link,
                displayPath: absolutePath,
                root: symlinkRoot,
            });
            return { path, type: 'symlink', mode: details.mode, link, size: 0 };
        }
        if (details.kind !== 'file') {
            throw new Error(
                `Unsupported ${this.rules.provider} transfer entry: ${absolutePath}`
            );
        }
        return { path, type: 'file', mode: details.mode, size: details.size };
    }

    /**
     * Records the digest of each file by reading it. With `streaming`, and a
     * source that can stream, only project npm configs are read here: the writer
     * digests every other file while packing, so each file is read once.
     */
    async digestEntries(
        source: string,
        entries: Map<string, SnapshotEntry>,
        sourceIsDirectory: boolean,
        streaming = false
    ): Promise<void> {
        const streamed = streaming && this.source.stream !== undefined;
        for (const entry of entries.values()) {
            if (entry.type !== 'file') continue;
            if (streamed && !this.protection.projectNpmrcPath(entry.path)) continue;
            entry.digest = await digestBytes(
                await this.source.read(
                    sourceIsDirectory ? join(source, entry.path) : source
                )
            );
        }
    }

    /**
     * Yields the selected entries as archive records, reading each file as it
     * goes. Symlinks become links. Project npm settings are re-validated against
     * the digest taken during selection, so a file that changes in between is
     * refused rather than copied. The caller writes the records into a tar: a
     * stream on disk, or bytes in memory. With `streaming`, and a source that
     * can stream, other files come back as `StreamedRecord` instead of bytes.
     */
    async *archiveRecords(
        source: string,
        entries: Map<string, SnapshotEntry>,
        sourceIsDirectory: boolean,
        streaming = false
    ): AsyncGenerator<TarEntry | StreamedRecord> {
        // Validate and retain the exact config bytes before writing the archive.
        const configs = new Map<string, Uint8Array>();
        for (const entry of entries.values()) {
            if (!sourceIsDirectory || !this.protection.projectNpmrcPath(entry.path))
                continue;
            const content = await this.source.read(join(source, entry.path));
            if (
                entry.type !== 'file' ||
                content.byteLength !== entry.size ||
                (await digestBytes(content)) !== entry.digest ||
                !this.protection.safeProjectNpmrc(content)
            ) {
                throw new Error(
                    `Project config changed or is unsafe for ${this.rules.provider} transfer: ${entry.path}`
                );
            }
            configs.set(entry.path, content);
        }
        for (const entry of entries.values()) {
            const absolutePath = sourceIsDirectory ? join(source, entry.path) : source;
            if (entry.type === 'symlink') {
                yield {
                    name: entry.path,
                    type: 'symlink',
                    mode: entry.mode,
                    content: new Uint8Array(),
                    link: entry.link ?? '',
                };
                continue;
            }
            const config = configs.get(entry.path);
            if (!config && streaming && this.source.stream) {
                yield {
                    type: 'stream',
                    name: entry.path,
                    mode: entry.mode,
                    size: entry.size,
                    body: this.source.stream(absolutePath),
                    entry,
                };
                continue;
            }
            const content = config ?? (await this.source.read(absolutePath));
            if (content.byteLength !== entry.size) {
                throw new Error(
                    `${this.rules.provider} transfer source changed while reading: ${entry.path}`
                );
            }
            yield { name: entry.path, type: 'file', mode: entry.mode, content };
        }
    }

    /** Builds the whole archive in memory. */
    async archiveBytes(
        source: string,
        entries: Map<string, SnapshotEntry>,
        sourceIsDirectory: boolean
    ): Promise<Uint8Array> {
        const records: TarEntry[] = [];
        for await (const record of this.archiveRecords(
            source,
            entries,
            sourceIsDirectory
        )) {
            if (record.type === 'stream') {
                throw new Error('A byte-array archive cannot hold a streamed record');
            }
            records.push(record);
        }
        return TarArchive.pack(records).gzip();
    }
}

export async function digestBytes(bytes: Uint8Array): Promise<string> {
    const digest = await crypto.subtle.digest(
        'SHA-256',
        bytes as Uint8Array<ArrayBuffer>
    );
    return `sha256:${Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, '0')
    ).join('')}`;
}
