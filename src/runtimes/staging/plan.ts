import { dirname, join, resolve } from 'node:path';

import {
    excludedByNestedAsset,
    normalizeArchivePath,
    projectNpmrcPath,
    protectedWorkspacePath,
    safeProjectNpmrc,
    validateRelativePath,
    validateSymlink,
} from './rules.js';
import type { AssetSource } from './source.js';
import { packTarGzip, type TarEntry } from './tar.js';

/** What a provider needs to copy a host path into a sandbox archive. */
export interface StagingContext {
    source: AssetSource;
    /** Provider name used in error messages, for example `E2B` or `Daytona`. */
    label: string;
}

export interface SnapshotEntry {
    path: string;
    type: 'file' | 'symlink';
    mode: number;
    digest?: string;
    link?: string;
    size: number;
}

/**
 * Chooses the files to copy from a directory asset. A workspace that is a Git
 * repository contributes its tracked and unignored files when the source knows
 * Git. Everything else is walked. Protected and nested-asset paths are recorded
 * in `excludedPaths` rather than copied.
 */
export async function selectPaths(
    context: StagingContext,
    binding: { hostPath: string; kind: string },
    excludedPaths: string[],
    syncExcludedPaths: string[]
): Promise<string[]> {
    const { source, label } = context;
    const listed =
        binding.kind === 'workspace'
            ? await source.git?.files(binding.hostPath)
            : undefined;
    if (!listed) {
        return walk(
            context,
            binding.hostPath,
            '',
            true,
            excludedPaths,
            syncExcludedPaths
        );
    }
    const names = listed.map(normalizeArchivePath).filter((path) => {
        // Git reports an untracked nested repository as one directory entry.
        // Expanding it would copy a second checkout, including agent worktrees.
        if (path.endsWith('/')) {
            excludedPaths.push(path.slice(0, -1));
            return false;
        }
        if (excludedByNestedAsset(path, syncExcludedPaths)) return false;
        if (!protectedWorkspacePath(path) || projectNpmrcPath(path)) return true;
        excludedPaths.push(path);
        return false;
    });
    const expanded: string[] = [];
    for (const name of names) {
        const path = join(binding.hostPath, name);
        const details = await source.lstat(path);
        if (!details) continue;
        if (projectNpmrcPath(name)) {
            if (!(await source.git?.tracked(binding.hostPath, name))) {
                excludedPaths.push(name);
                continue;
            }
            if (
                details.kind !== 'file' ||
                details.size > 64 * 1024 ||
                !safeProjectNpmrc(await source.read(path))
            ) {
                throw new Error(
                    `Cannot safely transfer tracked project config ${name} to ${label}. Only non-secret npm boolean settings are supported; remove credentials or unsupported settings before retrying.`
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

export async function walk(
    context: StagingContext,
    root: string,
    prefix = '',
    protectWorkspace = false,
    excludedPaths: string[] = [],
    syncExcludedPaths: string[] = []
): Promise<string[]> {
    const absolute = prefix ? resolve(root, prefix) : root;
    const entries = await context.source.list(absolute);
    const paths: string[] = [];
    for (const entry of entries.toSorted((left, right) => left.localeCompare(right))) {
        const name = normalizeArchivePath(prefix ? `${prefix}/${entry}` : entry);
        if (excludedByNestedAsset(name, syncExcludedPaths)) continue;
        if (protectWorkspace && protectedWorkspacePath(name)) {
            excludedPaths.push(name);
            continue;
        }
        const details = await context.source.lstat(join(root, name));
        if (!details) continue;
        if (details.kind === 'directory') {
            paths.push(
                ...(await walk(
                    context,
                    root,
                    name,
                    protectWorkspace,
                    excludedPaths,
                    syncExcludedPaths
                ))
            );
        } else if (details.kind === 'file' || details.kind === 'symlink') {
            paths.push(name);
        }
    }
    return paths;
}

export async function describeEntries(
    context: StagingContext,
    root: string,
    paths: string[],
    symlinkRoot: string
): Promise<Map<string, SnapshotEntry>> {
    const entries = new Map<string, SnapshotEntry>();
    for (const path of paths.toSorted()) {
        validateRelativePath(path, context.label);
        entries.set(
            path,
            await describeEntry(context, join(root, path), path, symlinkRoot)
        );
    }
    return entries;
}

export async function describeEntry(
    context: StagingContext,
    absolutePath: string,
    path: string,
    symlinkRoot: string
): Promise<SnapshotEntry> {
    const details = await context.source.lstat(absolutePath);
    if (!details) throw new Error(`Runtime asset does not exist: ${absolutePath}`);
    if (details.kind === 'symlink') {
        const link = await context.source.readLink(absolutePath);
        validateSymlink(
            dirname(absolutePath),
            link,
            absolutePath,
            symlinkRoot,
            context.label
        );
        return { path, type: 'symlink', mode: details.mode, link, size: 0 };
    }
    if (details.kind !== 'file') {
        throw new Error(`Unsupported ${context.label} transfer entry: ${absolutePath}`);
    }
    return { path, type: 'file', mode: details.mode, size: details.size };
}

export async function digestEntries(
    context: StagingContext,
    source: string,
    entries: Map<string, SnapshotEntry>,
    sourceIsDirectory: boolean
): Promise<void> {
    for (const entry of entries.values()) {
        if (entry.type !== 'file') continue;
        entry.digest = await digestBytes(
            await context.source.read(
                sourceIsDirectory ? join(source, entry.path) : source
            )
        );
    }
}

/**
 * Yields the selected entries as archive records, reading each file as it goes.
 * Symlinks become links. Project npm settings are re-validated against the
 * digest taken during selection, so a file that changes in between is refused
 * rather than copied. The caller writes the records into a tar: a stream on
 * disk (`pack.ts`), or bytes in memory.
 */
export async function* archiveRecords(
    context: StagingContext,
    source: string,
    entries: Map<string, SnapshotEntry>,
    sourceIsDirectory: boolean
): AsyncGenerator<TarEntry> {
    // Validate and retain the exact config bytes before writing the archive.
    const configs = new Map<string, Uint8Array>();
    for (const entry of entries.values()) {
        if (!sourceIsDirectory || !projectNpmrcPath(entry.path)) continue;
        const content = await context.source.read(join(source, entry.path));
        if (
            entry.type !== 'file' ||
            content.byteLength !== entry.size ||
            (await digestBytes(content)) !== entry.digest ||
            !safeProjectNpmrc(content)
        ) {
            throw new Error(
                `Project config changed or is unsafe for ${context.label} transfer: ${entry.path}`
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
        const content =
            configs.get(entry.path) ?? (await context.source.read(absolutePath));
        if (content.byteLength !== entry.size) {
            throw new Error(
                `${context.label} transfer source changed while reading: ${entry.path}`
            );
        }
        yield { name: entry.path, type: 'file', mode: entry.mode, content };
    }
}

/** Builds the whole archive in memory. */
export async function archiveBytes(
    context: StagingContext,
    source: string,
    entries: Map<string, SnapshotEntry>,
    sourceIsDirectory: boolean
): Promise<Uint8Array> {
    const records: TarEntry[] = [];
    for await (const record of archiveRecords(
        context,
        source,
        entries,
        sourceIsDirectory
    )) {
        records.push(record);
    }
    return packTarGzip(records);
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
