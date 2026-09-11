import { createHash } from 'node:crypto';
import {
    createReadStream as readStream,
    createWriteStream as writeStream,
} from 'node:fs';
import {
    chmod,
    copyFile,
    lstat,
    mkdir,
    mkdtemp,
    readdir,
    readlink,
    rm,
    symlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';

import tar from 'tar-stream';

import type { E2BAssetBinding } from './paths.js';

export interface E2BSnapshotEntry {
    path: string;
    type: 'file' | 'symlink';
    mode: number;
    digest?: string;
    link?: string;
    size: number;
}

export interface E2BSnapshotApplication {
    readonly bytes: number;
    apply(): Promise<void>;
    cleanup(): Promise<void>;
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
        private readonly temporaryDirectory: string
    ) {}

    static async create(
        binding: E2BAssetBinding,
        maximumBytes: number
    ): Promise<E2BAssetSnapshot> {
        const temporaryDirectory = await mkdtemp(join(tmpdir(), 'workbench-e2b-'));
        const archive = join(temporaryDirectory, 'asset.tar.gz');
        try {
            const source = await lstat(binding.hostPath);
            const excludedPaths: string[] = [];
            const syncExcludedPaths = binding.excludedHostPaths.map((path) =>
                normalizeArchivePath(relative(binding.hostPath, path))
            );
            excludedPaths.push(...syncExcludedPaths);
            const paths = source.isDirectory()
                ? await selectedPaths(binding, excludedPaths, syncExcludedPaths)
                : ['.workbench-file'];
            const entries = source.isDirectory()
                ? await describeEntries(binding.hostPath, paths, binding.hostPath)
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
            await writeArchive(
                binding.hostPath,
                archive,
                entries,
                source.isDirectory()
            );
            return new E2BAssetSnapshot(
                binding,
                archive,
                entries,
                excludedPaths,
                syncExcludedPaths,
                bytes,
                source.isDirectory(),
                temporaryDirectory
            );
        } catch (error) {
            await rm(temporaryDirectory, { recursive: true, force: true });
            throw error;
        }
    }

    async prepareApplication(
        archive: string,
        deletions: string[],
        maximumBytes = Number.POSITIVE_INFINITY,
        reportedMaximumBytes = maximumBytes
    ): Promise<E2BSnapshotApplication> {
        if (!this.sourceIsDirectory) {
            throw new Error('E2B file assets cannot be synchronized');
        }
        const extracted = await mkdtemp(join(tmpdir(), 'workbench-e2b-output-'));
        try {
            const bytes = await extractArchive(
                archive,
                extracted,
                maximumBytes,
                reportedMaximumBytes
            );
            const changed = await describeEntries(
                extracted,
                await walk(extracted, '', false),
                extracted
            );
            const conflicts: string[] = [];
            for (const [path, remote] of changed) {
                if (this.protectedOutputPath(path)) continue;
                await validateHostDestination(this.binding.hostPath, path);
                const baseline = this.entries.get(path);
                const current = await describeOptional(
                    join(this.binding.hostPath, path),
                    path,
                    this.binding.hostPath
                );
                if (conflictsWith(baseline, current, remote)) {
                    conflicts.push(path);
                }
            }
            for (const path of deletions) {
                validateRelativePath(path);
                if (this.protectedOutputPath(path)) continue;
                await validateHostDestination(this.binding.hostPath, path);
                const baseline = this.entries.get(path);
                if (!baseline) continue;
                const current = await describeOptional(
                    join(this.binding.hostPath, path),
                    path,
                    this.binding.hostPath
                );
                if (current && !sameEntry(current, baseline)) conflicts.push(path);
            }
            if (conflicts.length > 0) {
                throw new Error(
                    `E2B workspace changed locally during the run; remote changes were not applied to: ${[...new Set(conflicts)].toSorted().join(', ')}`
                );
            }
            let cleaned = false;
            return {
                bytes,
                apply: async () => {
                    for (const [path, remote] of changed) {
                        if (this.protectedOutputPath(path)) continue;
                        await validateHostDestination(this.binding.hostPath, path);
                        await installEntry(
                            join(extracted, path),
                            join(this.binding.hostPath, path),
                            remote,
                            this.binding.hostPath
                        );
                    }
                    for (const path of deletions) {
                        if (this.protectedOutputPath(path)) continue;
                        const baseline = this.entries.get(path);
                        if (!baseline) continue;
                        await validateHostDestination(this.binding.hostPath, path);
                        await rm(join(this.binding.hostPath, path), {
                            recursive: true,
                            force: true,
                        });
                    }
                },
                cleanup: async () => {
                    if (cleaned) return;
                    cleaned = true;
                    await rm(extracted, { recursive: true, force: true });
                },
            };
        } catch (error) {
            await rm(extracted, { recursive: true, force: true });
            throw error;
        }
    }

    async apply(archive: string, deletions: string[]): Promise<void> {
        if (!this.sourceIsDirectory) return;
        const application = await this.prepareApplication(archive, deletions);
        try {
            await application.apply();
        } finally {
            await application.cleanup();
        }
    }

    cleanup(): Promise<void> {
        return rm(this.temporaryDirectory, { recursive: true, force: true });
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

async function describeOptional(
    absolutePath: string,
    path: string,
    symlinkRoot: string
): Promise<E2BSnapshotEntry | undefined> {
    return describeEntry(absolutePath, path, symlinkRoot).catch((error) => {
        if (
            error instanceof Error &&
            'code' in error &&
            (error as NodeJS.ErrnoException).code === 'ENOENT'
        ) {
            return undefined;
        }
        throw error;
    });
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

export async function extractArchive(
    archive: string,
    destination: string,
    maximumBytes = Number.POSITIVE_INFINITY,
    reportedMaximumBytes = maximumBytes
): Promise<number> {
    const extract = tar.extract();
    let bytes = 0;
    extract.on('entry', (header, stream, next) => {
        void (async () => {
            const name = normalizeArchivePath(header.name);
            validateRelativePath(name);
            bytes += header.type === 'file' ? (header.size ?? 0) : 0;
            if (bytes > maximumBytes) {
                stream.resume();
                throw new Error(
                    `E2B output exceeds the ${formatBytes(reportedMaximumBytes)} transfer safety limit`
                );
            }
            const path = join(destination, name);
            await mkdir(dirname(path), { recursive: true });
            if (header.type === 'directory') {
                await mkdir(path, { recursive: true });
                stream.resume();
            } else if (header.type === 'symlink') {
                const link = header.linkname;
                if (!link) throw new Error(`E2B archive symlink is missing: ${name}`);
                validateSymlink(dirname(path), link, path, destination);
                await rm(path, { recursive: true, force: true });
                await symlink(link, path);
                stream.resume();
            } else if (header.type === 'file') {
                await rm(path, { recursive: true, force: true });
                await pipeline(stream, writeStream(path, { mode: header.mode }));
                await chmod(path, header.mode ?? 0o644);
            } else {
                stream.resume();
                throw new Error(`Unsupported E2B archive entry: ${name}`);
            }
        })().then(
            () => next(),
            (error) => extract.destroy(error as Error)
        );
    });
    await pipeline(readStream(archive), createGunzip(), extract);
    return bytes;
}

async function installEntry(
    source: string,
    destination: string,
    entry: E2BSnapshotEntry,
    root: string
): Promise<void> {
    await mkdir(dirname(destination), { recursive: true });
    await rm(destination, { recursive: true, force: true });
    if (entry.type === 'symlink') {
        const link = entry.link as string;
        validateSymlink(dirname(destination), link, destination, root);
        await symlink(link, destination);
        return;
    }
    await copyFile(source, destination);
    await chmod(destination, entry.mode);
}

function conflictsWith(
    baseline: E2BSnapshotEntry | undefined,
    current: E2BSnapshotEntry | undefined,
    remote: E2BSnapshotEntry
): boolean {
    if (!baseline) return Boolean(current && !sameEntry(current, remote));
    if (current && sameEntry(current, baseline)) return false;
    if (!current) return !sameEntry(remote, baseline);
    return !sameEntry(current, remote);
}

function sameEntry(left: E2BSnapshotEntry, right: E2BSnapshotEntry): boolean {
    return (
        left.type === right.type &&
        left.mode === right.mode &&
        left.digest === right.digest &&
        left.link === right.link
    );
}

async function digestFile(path: string): Promise<string> {
    const hash = createHash('sha256');
    for await (const chunk of readStream(path)) hash.update(chunk);
    return `sha256:${hash.digest('hex')}`;
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

async function validateHostDestination(root: string, path: string): Promise<void> {
    validateRelativePath(path);
    const rootEntry = await lstat(root);
    if (rootEntry.isSymbolicLink() || !rootEntry.isDirectory()) {
        throw new Error(`E2B workspace root became unsafe during the run: ${root}`);
    }
    let parent = root;
    for (const segment of path.split('/').slice(0, -1)) {
        parent = join(parent, segment);
        const entry = await lstat(parent).catch((error) => {
            if (
                error instanceof Error &&
                'code' in error &&
                (error as NodeJS.ErrnoException).code === 'ENOENT'
            ) {
                return undefined;
            }
            throw error;
        });
        if (!entry) return;
        if (entry.isSymbolicLink() || !entry.isDirectory()) {
            throw new Error(
                `E2B workspace destination has an unsafe parent: ${join(root, path)}`
            );
        }
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
            ['.git', '.hg', '.svn', '.ssh', '.aws', '.gnupg', 'node_modules'].includes(
                segment
            )
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
