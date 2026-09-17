import { createHash } from 'node:crypto';
import {
    createReadStream as readStream,
    createWriteStream as writeStream,
} from 'node:fs';
import { lstat, mkdtemp, readdir, readlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';

import tar from 'tar-stream';

import type { OutcomeChangeset, OutcomeWorkspace } from '../../outcomes/contracts.js';
import type { OutcomeStore } from '../../outcomes/store.js';
import { WorkspaceSnapshot } from '../../outcomes/workspace.js';
import { extractArchive } from './archive.js';
import type { E2BAssetBinding } from './paths.js';
import { type E2BStateSource, E2BStateStore } from './state.js';

export { extractArchive } from './archive.js';

export interface E2BSnapshotEntry {
    path: string;
    type: 'file' | 'symlink';
    mode: number;
    digest?: string;
    link?: string;
    size: number;
}

export interface E2BSnapshotOutcome {
    readonly bytes: number;
    collect(store: OutcomeStore): Promise<OutcomeChangeset | undefined>;
    cleanup(): Promise<void>;
}

export interface E2BRecoverySnapshot {
    binding: E2BAssetBinding;
    archive?: string;
    excludedPaths: string[];
    syncExcludedPaths: string[];
    sourceIsDirectory: boolean;
    gitRevision?: string;
    stateVersion?: string;
}

export class E2BAssetSnapshot {
    private constructor(
        readonly binding: E2BAssetBinding,
        readonly archive: string,
        readonly entries: Map<string, E2BSnapshotEntry>,
        readonly excludedPaths: string[],
        readonly syncExcludedPaths: string[],
        readonly bytes: number,
        readonly sourceIsDirectory: boolean,
        readonly gitRevision: string | undefined,
        private readonly temporaryDirectory: string | undefined,
        private readonly stateSource?: E2BStateSource
    ) {}

    static async create(
        binding: E2BAssetBinding,
        maximumBytes: number,
        persistentDirectory?: string
    ): Promise<E2BAssetSnapshot> {
        if (binding.kind === 'state' || binding.kind === 'credentials') {
            return new E2BStateStore(binding.hostPath).withSource((source) =>
                E2BAssetSnapshot.createFrom(binding, maximumBytes, source)
            );
        }
        return E2BAssetSnapshot.createFrom(
            binding,
            maximumBytes,
            undefined,
            persistentDirectory
        );
    }

    private static async createFrom(
        binding: E2BAssetBinding,
        maximumBytes: number,
        stateSource?: E2BStateSource,
        persistentDirectory?: string
    ): Promise<E2BAssetSnapshot> {
        const temporaryDirectory = await mkdtemp(
            join(persistentDirectory ?? tmpdir(), 'workbench-e2b-')
        );
        const archive = join(temporaryDirectory, 'asset.tar.gz');
        const sourcePath = stateSource?.directory ?? binding.hostPath;
        try {
            const source = await lstat(sourcePath);
            const excludedPaths: string[] = [];
            const syncExcludedPaths = binding.excludedHostPaths.map((path) =>
                normalizeArchivePath(relative(binding.hostPath, path))
            );
            excludedPaths.push(...syncExcludedPaths);
            const paths = source.isDirectory()
                ? await selectedPaths(
                      { ...binding, hostPath: sourcePath },
                      excludedPaths,
                      syncExcludedPaths
                  )
                : ['.workbench-file'];
            const entries = source.isDirectory()
                ? await describeEntries(sourcePath, paths, sourcePath)
                : new Map([
                      [
                          '.workbench-file',
                          await describeEntry(
                              binding.hostPath,
                              '.workbench-file',
                              dirname(binding.hostPath)
                          ),
                      ],
                  ]);
            const bytes = [...entries.values()].reduce(
                (total, entry) => total + entry.size,
                0
            );
            if (bytes > maximumBytes) {
                throw new Error(
                    `E2B transfer exceeds the ${formatBytes(maximumBytes)} safety limit: ${binding.hostPath} is ${formatBytes(bytes)}`
                );
            }
            await writeArchive(sourcePath, archive, entries, source.isDirectory());
            return new E2BAssetSnapshot(
                binding,
                archive,
                entries,
                excludedPaths,
                syncExcludedPaths,
                bytes,
                source.isDirectory(),
                binding.kind === 'workspace'
                    ? await currentGitRevision(binding.hostPath)
                    : undefined,
                temporaryDirectory,
                stateSource
            );
        } catch (error) {
            await rm(temporaryDirectory, { recursive: true, force: true });
            throw error;
        }
    }

    async persistState(archive: string, maximumBytes: number): Promise<number> {
        if (!this.stateSource) throw new Error('Snapshot is not managed native state');
        return new E2BStateStore(this.binding.hostPath).install(
            archive,
            this.stateSource.version,
            maximumBytes
        );
    }

    recoverySnapshot(directory: string): E2BRecoverySnapshot {
        return {
            binding: this.binding,
            excludedPaths: this.excludedPaths,
            syncExcludedPaths: this.syncExcludedPaths,
            sourceIsDirectory: this.sourceIsDirectory,
            ...(this.binding.kind === 'workspace'
                ? { archive: relative(directory, this.archive) }
                : {}),
            ...(this.gitRevision ? { gitRevision: this.gitRevision } : {}),
            ...(this.stateSource ? { stateVersion: this.stateSource.version } : {}),
        };
    }

    static fromRecovery(
        record: E2BRecoverySnapshot,
        directory: string
    ): E2BAssetSnapshot {
        return new E2BAssetSnapshot(
            record.binding,
            record.archive ? join(directory, record.archive) : '',
            new Map(),
            record.excludedPaths,
            record.syncExcludedPaths,
            0,
            record.sourceIsDirectory,
            record.gitRevision,
            undefined,
            record.stateVersion
                ? { directory: record.binding.hostPath, version: record.stateVersion }
                : undefined
        );
    }

    async prepareOutcome(
        archive: string,
        deletions: string[],
        workspace: OutcomeWorkspace,
        maximumBytes = 512 * 1_024 * 1_024,
        reportedMaximumBytes = maximumBytes
    ): Promise<E2BSnapshotOutcome> {
        if (!this.sourceIsDirectory) {
            throw new Error('E2B file assets cannot produce workspace outcomes');
        }
        const materialized = await mkdtemp(join(tmpdir(), 'workbench-e2b-outcome-'));
        let baseline: WorkspaceSnapshot | undefined;
        try {
            await extractArchive(this.archive, materialized);
            baseline = await WorkspaceSnapshot.create(materialized, {
                workspace,
                maximumBytes,
            });
            for (const path of deletions) {
                validateRelativePath(path);
                if (this.protectedOutputPath(path)) continue;
                await rm(join(materialized, path), { recursive: true, force: true });
            }
            const bytes = await extractArchive(
                archive,
                materialized,
                maximumBytes,
                reportedMaximumBytes
            );
            for (const path of await walk(materialized, '', false)) {
                if (this.protectedOutputPath(path))
                    await rm(join(materialized, path), { force: true });
            }
            const captured = baseline;
            let cleaned = false;
            return {
                bytes,
                collect: async (store) => {
                    const changeset = await captured.collect(store);
                    if (!changeset || !this.gitRevision) return changeset;
                    return {
                        ...changeset,
                        base: {
                            ...changeset.base,
                            git_revision: this.gitRevision,
                        },
                    };
                },
                cleanup: async () => {
                    if (cleaned) return;
                    cleaned = true;
                    await Promise.allSettled([
                        captured.cleanup(),
                        rm(materialized, { recursive: true, force: true }),
                    ]);
                },
            };
        } catch (error) {
            await baseline?.cleanup().catch(() => undefined);
            await rm(materialized, { recursive: true, force: true });
            throw error;
        }
    }

    cleanup(): Promise<void> {
        return this.temporaryDirectory
            ? rm(this.temporaryDirectory, { recursive: true, force: true })
            : Promise.resolve();
    }

    private protectedOutputPath(path: string): boolean {
        return (
            protectedWorkspacePath(path) ||
            excludedByNestedAsset(path, this.syncExcludedPaths)
        );
    }
}

async function selectedPaths(
    binding: E2BAssetBinding,
    excludedPaths: string[],
    syncExcludedPaths: string[]
): Promise<string[]> {
    if (binding.kind !== 'workspace') {
        return walk(binding.hostPath, '', true, excludedPaths, syncExcludedPaths);
    }
    const git = Bun.spawn(
        [
            'git',
            'ls-files',
            '--cached',
            '--others',
            '--exclude-standard',
            '-z',
            '--',
            '.',
        ],
        {
            cwd: binding.hostPath,
            stdin: 'ignore',
            stdout: 'pipe',
            stderr: 'ignore',
        }
    );
    const output = new Uint8Array(await new Response(git.stdout).arrayBuffer());
    if ((await git.exited) !== 0) {
        return walk(binding.hostPath, '', true, excludedPaths, syncExcludedPaths);
    }
    const names = new TextDecoder()
        .decode(output)
        .split('\0')
        .filter(Boolean)
        .map(normalizeArchivePath)
        .filter((path) => {
            // Git reports an untracked nested repository as one directory entry.
            // Expanding it would copy a second checkout, including agent worktrees.
            if (path.endsWith('/')) {
                excludedPaths.push(path.slice(0, -1));
                return false;
            }
            if (excludedByNestedAsset(path, syncExcludedPaths)) return false;
            if (!protectedWorkspacePath(path)) return true;
            excludedPaths.push(path);
            return false;
        });
    const expanded: string[] = [];
    for (const name of names) {
        const path = join(binding.hostPath, name);
        const details = await lstat(path).catch(() => undefined);
        if (!details) continue;
        if (details.isDirectory()) {
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

async function walk(
    root: string,
    prefix = '',
    protectWorkspace = false,
    excludedPaths: string[] = [],
    syncExcludedPaths: string[] = []
): Promise<string[]> {
    const absolute = prefix ? resolve(root, prefix) : root;
    const entries = await readdir(absolute, { withFileTypes: true });
    const paths: string[] = [];
    for (const entry of entries.toSorted((left, right) =>
        left.name.localeCompare(right.name)
    )) {
        const name = normalizeArchivePath(
            prefix ? `${prefix}/${entry.name}` : entry.name
        );
        if (excludedByNestedAsset(name, syncExcludedPaths)) continue;
        if (protectWorkspace && protectedWorkspacePath(name)) {
            excludedPaths.push(name);
            continue;
        }
        const path = join(root, name);
        const details = await lstat(path);
        if (details.isDirectory()) {
            paths.push(
                ...(await walk(
                    root,
                    name,
                    protectWorkspace,
                    excludedPaths,
                    syncExcludedPaths
                ))
            );
        } else if (details.isFile() || details.isSymbolicLink()) {
            paths.push(name);
        }
    }
    return paths;
}

function excludedByNestedAsset(path: string, roots: string[]): boolean {
    return roots.some((root) => path === root || path.startsWith(`${root}/`));
}

async function describeEntries(
    root: string,
    paths: string[],
    symlinkRoot: string
): Promise<Map<string, E2BSnapshotEntry>> {
    const entries = new Map<string, E2BSnapshotEntry>();
    for (const path of paths.toSorted()) {
        validateRelativePath(path);
        entries.set(path, await describeEntry(join(root, path), path, symlinkRoot));
    }
    return entries;
}

async function describeEntry(
    absolutePath: string,
    path: string,
    symlinkRoot: string
): Promise<E2BSnapshotEntry> {
    const details = await lstat(absolutePath);
    if (details.isSymbolicLink()) {
        const link = await readlink(absolutePath);
        validateSymlink(dirname(absolutePath), link, absolutePath, symlinkRoot);
        return {
            path,
            type: 'symlink',
            mode: details.mode & 0o777,
            link,
            size: 0,
        };
    }
    if (!details.isFile()) {
        throw new Error(`Unsupported E2B transfer entry: ${absolutePath}`);
    }
    return {
        path,
        type: 'file',
        mode: details.mode & 0o777,
        digest: await digestFile(absolutePath),
        size: details.size,
    };
}

async function writeArchive(
    source: string,
    archive: string,
    entries: Map<string, E2BSnapshotEntry>,
    sourceIsDirectory: boolean
): Promise<void> {
    const pack = tar.pack();
    const writing = pipeline(pack, createGzip(), writeStream(archive, { mode: 0o600 }));
    for (const entry of entries.values()) {
        const absolutePath = sourceIsDirectory ? join(source, entry.path) : source;
        if (entry.type === 'symlink') {
            await new Promise<void>((resolveEntry, reject) => {
                pack.entry(
                    {
                        name: entry.path,
                        type: 'symlink',
                        linkname: entry.link,
                        mode: entry.mode,
                    },
                    (error) => (error ? reject(error) : resolveEntry())
                );
            });
            continue;
        }
        const target = pack.entry({
            name: entry.path,
            type: 'file',
            size: entry.size,
            mode: entry.mode,
        });
        await pipeline(readStream(absolutePath), target);
    }
    pack.finalize();
    await writing;
}

async function digestFile(path: string): Promise<string> {
    const hash = createHash('sha256');
    for await (const chunk of readStream(path)) hash.update(chunk);
    return `sha256:${hash.digest('hex')}`;
}

async function currentGitRevision(root: string): Promise<string | undefined> {
    const child = Bun.spawn(['git', 'rev-parse', 'HEAD'], {
        cwd: root,
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'ignore',
    });
    const output = await new Response(child.stdout).text();
    if ((await child.exited) !== 0) return undefined;
    const revision = output.trim();
    return /^[a-f0-9]{40,64}$/.test(revision) ? revision : undefined;
}

function validateRelativePath(path: string): void {
    if (
        !path ||
        path === '.' ||
        isAbsolute(path) ||
        path.split('/').some((segment) => segment === '..' || segment === '')
    ) {
        throw new Error(`Unsafe E2B archive path: ${path}`);
    }
}

function validateSymlink(
    parent: string,
    link: string,
    displayPath: string,
    root?: string
): void {
    if (isAbsolute(link)) {
        throw new Error(
            `Absolute symlink is not allowed in E2B transfer: ${displayPath}`
        );
    }
    if (root && !contains(root, resolve(parent, link))) {
        throw new Error(
            `Escaping symlink is not allowed in E2B transfer: ${displayPath}`
        );
    }
}

function protectedWorkspacePath(path: string): boolean {
    const segments = path.split('/');
    if (
        segments.some((segment) =>
            [
                '.git',
                '.hg',
                '.svn',
                '.ssh',
                '.aws',
                '.gnupg',
                '.workbench-state',
                'node_modules',
            ].includes(segment)
        )
    ) {
        return true;
    }
    const name = basename(path).toLowerCase();
    if (
        name === '.env' ||
        (name.startsWith('.env.') && !['.env.example', '.env.sample'].includes(name))
    ) {
        return true;
    }
    if (
        ['.npmrc', '.netrc', '.pypirc', 'id_rsa', 'id_ed25519', 'credentials'].includes(
            name
        )
    ) {
        return true;
    }
    return ['.pem', '.key', '.p12', '.pfx', '.kubeconfig'].some((extension) =>
        name.endsWith(extension)
    );
}

function normalizeArchivePath(path: string): string {
    return path.split(sep).join('/').replace(/^\.\//, '');
}

function contains(parent: string, child: string): boolean {
    const suffix = relative(resolve(parent), resolve(child));
    return (
        suffix === '' ||
        (!suffix.startsWith(`..${sep}`) && suffix !== '..' && !isAbsolute(suffix))
    );
}

function formatBytes(bytes: number): string {
    if (bytes < 1_024) return `${bytes} B`;
    const units = ['KiB', 'MiB', 'GiB'];
    let value = bytes;
    let unit = 'B';
    for (const next of units) {
        value /= 1_024;
        unit = next;
        if (value < 1_024) break;
    }
    return `${value.toFixed(value < 10 ? 1 : 0)} ${unit}`;
}
