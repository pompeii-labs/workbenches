import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import {
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

import type {
    OutcomeChangeEntry,
    OutcomeChangeset,
    OutcomeDigest,
    OutcomePathFingerprint,
    OutcomeWorkspace,
} from './contracts.js';
import type { OutcomeStore } from './store.js';

const defaultMaximumSnapshotBytes = 512 * 1_024 * 1_024;

interface SnapshotEntry {
    path: string;
    type: 'file' | 'symlink';
    mode: number;
    size: number;
    digest?: OutcomeDigest;
    target?: string;
}

export interface WorkspaceSnapshotOptions {
    workspace: OutcomeWorkspace;
    excludedPaths?: string[];
    maximumBytes?: number;
}

export class WorkspaceSnapshot {
    private constructor(
        readonly root: string,
        readonly workspace: OutcomeWorkspace,
        readonly snapshotDigest: OutcomeDigest,
        readonly gitRevision: string | undefined,
        private readonly baselineRoot: string,
        private readonly temporaryDirectory: string,
        private readonly entries: Map<string, SnapshotEntry>,
        private readonly excludedPaths: string[],
        private readonly maximumBytes: number
    ) {}

    static async create(
        root: string,
        options: WorkspaceSnapshotOptions
    ): Promise<WorkspaceSnapshot> {
        const resolvedRoot = resolve(root);
        const details = await lstat(resolvedRoot);
        if (details.isSymbolicLink() || !details.isDirectory()) {
            throw new Error(`Outcome workspace must be a directory: ${resolvedRoot}`);
        }
        const maximumBytes = options.maximumBytes ?? defaultMaximumSnapshotBytes;
        if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) {
            throw new Error(
                'Workspace snapshot maximumBytes must be a positive integer'
            );
        }
        const temporaryDirectory = await mkdtemp(
            join(tmpdir(), 'workbench-outcome-snapshot-')
        );
        const baselineRoot = join(temporaryDirectory, 'baseline');
        await mkdir(baselineRoot, { recursive: true, mode: 0o700 });
        const excludedPaths = (options.excludedPaths ?? [])
            .flatMap((path) => relativeIfContained(resolvedRoot, path))
            .toSorted();
        try {
            const paths = await selectedPaths(resolvedRoot, excludedPaths);
            const entries = await describeEntries(resolvedRoot, paths);
            const bytes = [...entries.values()].reduce(
                (total, entry) => total + entry.size,
                0
            );
            if (bytes > maximumBytes) {
                throw new Error(
                    `Workspace snapshot exceeds the ${formatBytes(maximumBytes)} safety limit: ${resolvedRoot} is ${formatBytes(bytes)}`
                );
            }
            for (const entry of entries.values()) {
                await cloneEntry(
                    join(resolvedRoot, entry.path),
                    join(baselineRoot, entry.path),
                    entry,
                    baselineRoot
                );
            }
            return new WorkspaceSnapshot(
                resolvedRoot,
                options.workspace,
                digestEntries(entries),
                await gitRevision(resolvedRoot),
                baselineRoot,
                temporaryDirectory,
                entries,
                excludedPaths,
                maximumBytes
            );
        } catch (error) {
            await rm(temporaryDirectory, { recursive: true, force: true });
            throw error;
        }
    }

    async collect(store: OutcomeStore): Promise<OutcomeChangeset | undefined> {
        const currentPaths = await selectedPaths(this.root, this.excludedPaths);
        const current = await describeEntries(this.root, currentPaths);
        const paths = new Set([...this.entries.keys(), ...current.keys()]);
        const changed = [...paths]
            .toSorted()
            .filter((path) => !sameEntry(this.entries.get(path), current.get(path)));
        if (changed.length === 0) return undefined;
        let materialized = 0;
        const entries: OutcomeChangeEntry[] = [];
        let binaryFiles = 0;
        for (const path of changed) {
            const before = this.entries.get(path);
            const after = current.get(path);
            materialized += after?.size ?? 0;
            if (materialized > this.maximumBytes) {
                throw new Error(
                    `Workspace changes exceed the ${formatBytes(this.maximumBytes)} safety limit`
                );
            }
            if (!before && after) {
                entries.push({
                    path,
                    operation: 'add',
                    after: await this.outcomeState(store, after),
                });
            } else if (before && !after) {
                entries.push({
                    path,
                    operation: 'delete',
                    before: fingerprint(before),
                });
            } else if (before && after) {
                entries.push({
                    path,
                    operation: 'modify',
                    before: fingerprint(before),
                    after: await this.outcomeState(store, after),
                });
            }
            const binaryPath = after
                ? join(this.root, path)
                : join(this.baselineRoot, path);
            if (
                (after ?? before)?.type === 'file' &&
                (await isBinaryFile(binaryPath))
            ) {
                binaryFiles += 1;
            }
        }
        const reviewSource = await this.review(entries);
        const review = reviewSource
            ? await store.putBytes(reviewSource, 'text/x-diff')
            : undefined;
        return {
            id: changesetId(this.workspace),
            workspace: this.workspace,
            base: {
                snapshot_digest: this.snapshotDigest,
                ...(this.gitRevision ? { git_revision: this.gitRevision } : {}),
            },
            entries,
            ...(review ? { review } : {}),
            stats: {
                additions: entries.filter((entry) => entry.operation === 'add').length,
                modifications: entries.filter((entry) => entry.operation === 'modify')
                    .length,
                deletions: entries.filter((entry) => entry.operation === 'delete')
                    .length,
                binary_files: binaryFiles,
            },
        };
    }

    cleanup(): Promise<void> {
        return rm(this.temporaryDirectory, { recursive: true, force: true });
    }

    private async outcomeState(store: OutcomeStore, entry: SnapshotEntry) {
        if (entry.type === 'symlink') {
            return {
                kind: 'symlink' as const,
                mode: entry.mode,
                target: entry.target as string,
            };
        }
        return {
            kind: 'file' as const,
            mode: entry.mode,
            content: await store.putFile(join(this.root, entry.path)),
        };
    }

    private async review(entries: OutcomeChangeEntry[]): Promise<string> {
        const directory = await mkdtemp(join(tmpdir(), 'workbench-outcome-review-'));
        const beforeRoot = join(directory, 'before');
        const afterRoot = join(directory, 'after');
        try {
            await Promise.all([
                mkdir(beforeRoot, { recursive: true, mode: 0o700 }),
                mkdir(afterRoot, { recursive: true, mode: 0o700 }),
            ]);
            for (const entry of entries) {
                if (entry.before) {
                    const baseline = this.entries.get(entry.path);
                    if (baseline) {
                        await cloneEntry(
                            join(this.baselineRoot, entry.path),
                            join(beforeRoot, entry.path),
                            baseline,
                            beforeRoot
                        );
                    }
                }
                if (entry.after) {
                    const current = await describeEntry(
                        join(this.root, entry.path),
                        entry.path,
                        this.root
                    );
                    await cloneEntry(
                        join(this.root, entry.path),
                        join(afterRoot, entry.path),
                        current,
                        afterRoot
                    );
                }
            }
            const child = Bun.spawn(
                [
                    'git',
                    'diff',
                    '--no-index',
                    '--binary',
                    '--no-renames',
                    '--no-ext-diff',
                    '--',
                    'before',
                    'after',
                ],
                {
                    cwd: directory,
                    stdin: 'ignore',
                    stdout: 'pipe',
                    stderr: 'pipe',
                }
            );
            const [code, stdout, stderr] = await Promise.all([
                child.exited,
                new Response(child.stdout).text(),
                new Response(child.stderr).text(),
            ]);
            if (code !== 0 && code !== 1) {
                throw new Error(
                    `Failed to render outcome review diff: ${stderr.trim()}`
                );
            }
            return stdout
                .replaceAll('a/before/', 'a/')
                .replaceAll('b/after/', 'b/')
                .replaceAll('a/before', 'a')
                .replaceAll('b/after', 'b');
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    }
}

async function selectedPaths(root: string, excludedPaths: string[]): Promise<string[]> {
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
        { cwd: root, stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' }
    );
    const output = new Uint8Array(await new Response(git.stdout).arrayBuffer());
    if ((await git.exited) !== 0) return walk(root, '', excludedPaths);
    const selected: string[] = [];
    for (const value of new TextDecoder().decode(output).split('\0').filter(Boolean)) {
        const path = normalizePath(value);
        if (excluded(path, excludedPaths) || protectedPath(path)) continue;
        const details = await lstat(join(root, path)).catch(() => undefined);
        if (!details || details.isDirectory()) continue;
        if (details.isFile() || details.isSymbolicLink()) selected.push(path);
    }
    return [...new Set(selected)].toSorted();
}

async function walk(
    root: string,
    prefix: string,
    excludedPaths: string[]
): Promise<string[]> {
    const entries = await readdir(prefix ? join(root, prefix) : root, {
        withFileTypes: true,
    });
    const paths: string[] = [];
    for (const entry of entries.toSorted((left, right) =>
        left.name.localeCompare(right.name)
    )) {
        const path = normalizePath(prefix ? `${prefix}/${entry.name}` : entry.name);
        if (excluded(path, excludedPaths) || protectedPath(path)) continue;
        if (entry.isDirectory()) {
            paths.push(...(await walk(root, path, excludedPaths)));
        } else if (entry.isFile() || entry.isSymbolicLink()) {
            paths.push(path);
        }
    }
    return paths;
}

async function describeEntries(
    root: string,
    paths: string[]
): Promise<Map<string, SnapshotEntry>> {
    const entries = new Map<string, SnapshotEntry>();
    for (const path of paths) {
        entries.set(path, await describeEntry(join(root, path), path, root));
    }
    return entries;
}

async function describeEntry(
    absolute: string,
    path: string,
    root: string
): Promise<SnapshotEntry> {
    const details = await lstat(absolute);
    if (details.isSymbolicLink()) {
        const target = await readlink(absolute);
        validateSymlink(dirname(absolute), target, root, path);
        return {
            path,
            type: 'symlink',
            mode: details.mode & 0o777,
            size: 0,
            target,
        };
    }
    if (!details.isFile()) throw new Error(`Unsupported outcome path: ${absolute}`);
    return {
        path,
        type: 'file',
        mode: details.mode & 0o777,
        size: details.size,
        digest: await digestFile(absolute),
    };
}

async function cloneEntry(
    source: string,
    destination: string,
    entry: SnapshotEntry,
    root: string
): Promise<void> {
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    if (entry.type === 'symlink') {
        validateSymlink(dirname(destination), entry.target as string, root, entry.path);
        await symlink(entry.target as string, destination);
        return;
    }
    try {
        await copyFile(source, destination, constants.COPYFILE_FICLONE);
    } catch (error) {
        if (!isCloneUnsupported(error)) throw error;
        await copyFile(source, destination);
    }
}

function fingerprint(entry: SnapshotEntry): OutcomePathFingerprint {
    if (entry.type === 'symlink') {
        return {
            kind: 'symlink',
            mode: entry.mode,
            target: entry.target as string,
        };
    }
    return {
        kind: 'file',
        digest: entry.digest as OutcomeDigest,
        mode: entry.mode,
        size_bytes: entry.size,
    };
}

function sameEntry(
    left: SnapshotEntry | undefined,
    right: SnapshotEntry | undefined
): boolean {
    return (
        left?.type === right?.type &&
        left?.mode === right?.mode &&
        left?.size === right?.size &&
        left?.digest === right?.digest &&
        left?.target === right?.target
    );
}

function digestEntries(entries: Map<string, SnapshotEntry>): OutcomeDigest {
    const hash = createHash('sha256');
    for (const entry of [...entries.values()].toSorted((left, right) =>
        left.path.localeCompare(right.path)
    )) {
        hash.update(entry.path);
        hash.update('\0');
        hash.update(entry.type);
        hash.update('\0');
        hash.update(String(entry.mode));
        hash.update('\0');
        hash.update(entry.digest ?? entry.target ?? '');
        hash.update('\0');
        hash.update(String(entry.size));
        hash.update('\0');
    }
    return `sha256:${hash.digest('hex')}`;
}

async function digestFile(path: string): Promise<OutcomeDigest> {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    return `sha256:${hash.digest('hex')}`;
}

async function gitRevision(root: string): Promise<string | undefined> {
    const child = Bun.spawn(['git', 'rev-parse', 'HEAD'], {
        cwd: root,
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'ignore',
    });
    const output = (await new Response(child.stdout).text()).trim();
    return (await child.exited) === 0 && /^[a-f0-9]{40,64}$/.test(output)
        ? output
        : undefined;
}

async function isBinaryFile(path: string): Promise<boolean> {
    const file = Bun.file(path);
    const bytes = new Uint8Array(await file.slice(0, 8_192).arrayBuffer());
    return bytes.includes(0);
}

function protectedPath(path: string): boolean {
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

function excluded(path: string, roots: string[]): boolean {
    return roots.some((root) => path === root || path.startsWith(`${root}/`));
}

function relativeIfContained(root: string, path: string): string[] {
    const suffix = relative(root, resolve(path));
    return suffix &&
        !suffix.startsWith(`..${sep}`) &&
        suffix !== '..' &&
        !isAbsolute(suffix)
        ? [normalizePath(suffix)]
        : [];
}

function validateSymlink(
    parent: string,
    target: string,
    root: string,
    displayPath: string
): void {
    if (isAbsolute(target) || !contains(root, resolve(parent, target))) {
        throw new Error(`Escaping symlink is not allowed in outcome: ${displayPath}`);
    }
}

function contains(parent: string, child: string): boolean {
    const suffix = relative(resolve(parent), resolve(child));
    return (
        suffix === '' ||
        (!suffix.startsWith(`..${sep}`) && suffix !== '..' && !isAbsolute(suffix))
    );
}

function normalizePath(path: string): string {
    return path.split(sep).join('/').replace(/^\.\//, '').replace(/\/$/, '');
}

function changesetId(workspace: OutcomeWorkspace): string {
    if (workspace.kind === 'primary') return 'change_primary';
    const normalized = workspace.name.toLowerCase().replace(/[^a-z0-9]+/g, '_');
    return `change_${normalized || 'workspace'}`;
}

function isCloneUnsupported(error: unknown): boolean {
    return (
        error instanceof Error &&
        'code' in error &&
        ['EINVAL', 'ENOTSUP', 'EXDEV'].includes(
            (error as NodeJS.ErrnoException).code ?? ''
        )
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
