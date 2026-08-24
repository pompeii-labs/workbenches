import { createHash } from 'node:crypto';
import {
    lstat,
    mkdir,
    readdir,
    readFile,
    rename,
    rm,
    stat,
    writeFile,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';

import type { RemoteWorkbenchPackage } from './github.js';
import type { ResolvedWorkbench, WorkbenchManifest } from './types.js';

export interface SnapshotFile {
    path: string;
    bytes: Uint8Array;
    executable: boolean;
}

export interface CatalogEntry {
    alias: string;
    name: string;
    version: string;
    source: string;
    selector: string;
    digest: string;
    packagePath: string;
    addedAt: string;
    revision?: string;
    registry?: CatalogRegistryReference;
}

export interface CatalogRegistryReference {
    url: string;
    publisher: string;
    workbench: string;
    version_id: string;
}

export interface CatalogUpgrade {
    source: string;
    selector: string;
    manifest: WorkbenchManifest;
    files: SnapshotFile[];
    revision?: string;
    expectedDigest?: string;
    registry?: CatalogRegistryReference;
}

export interface CatalogUpgradeResult {
    previous: CatalogEntry;
    entry: CatalogEntry;
    changed: boolean;
}

interface CatalogFile {
    version: 1;
    entries: CatalogEntry[];
}

export async function readCatalog(home: string): Promise<CatalogEntry[]> {
    const path = join(home, 'catalog.json');
    const source = await readFile(path, 'utf8').catch(() => null);
    if (!source) return [];
    const parsed = JSON.parse(source) as Partial<CatalogFile>;
    if (parsed.version !== 1 || !Array.isArray(parsed.entries)) {
        throw new Error(`Unsupported Workbench catalog: ${path}`);
    }
    return parsed.entries;
}

export async function addToCatalog(options: {
    home: string;
    alias: string;
    source: string;
    revision?: string;
    workbench: ResolvedWorkbench;
}): Promise<CatalogEntry> {
    return savePackage({
        home: options.home,
        alias: options.alias,
        source: options.source,
        ...(options.revision ? { revision: options.revision } : {}),
        selector: basename(options.workbench.packageDirectory),
        manifest: options.workbench.manifest,
        files: await workbenchPackageFiles(options.workbench),
    });
}

export async function workbenchPackageFiles(
    workbench: ResolvedWorkbench
): Promise<SnapshotFile[]> {
    ensurePortablePackage(workbench);
    await rejectSymlinks(workbench.packageDirectory);
    return localPackageFiles(workbench.packageDirectory);
}

export async function addRemoteToCatalog(options: {
    home: string;
    alias: string;
    workbench: RemoteWorkbenchPackage;
    expectedDigest?: string;
    registry?: CatalogRegistryReference;
}): Promise<CatalogEntry> {
    return savePackage({
        home: options.home,
        alias: options.alias,
        source: options.workbench.source,
        revision: options.workbench.revision,
        selector: options.workbench.selector,
        manifest: options.workbench.manifest,
        files: options.workbench.files,
        ...(options.expectedDigest ? { expectedDigest: options.expectedDigest } : {}),
        ...(options.registry ? { registry: options.registry } : {}),
    });
}

async function savePackage(options: {
    home: string;
    alias: string;
    source: string;
    revision?: string;
    selector: string;
    manifest: WorkbenchManifest;
    files: SnapshotFile[];
    expectedDigest?: string;
    registry?: CatalogRegistryReference;
}): Promise<CatalogEntry> {
    validateAlias(options.alias);
    const entries = await readCatalog(options.home);
    if (entries.some((entry) => entry.alias === options.alias)) {
        throw new Error(`Saved Workbench already exists: ${options.alias}`);
    }
    const entry = await materializeCatalogEntry(options);
    await writeCatalog(options.home, [...entries, entry]);
    return entry;
}

export async function upgradeCatalogEntry(
    home: string,
    alias: string,
    upgrade: CatalogUpgrade
): Promise<CatalogUpgradeResult> {
    validateAlias(alias);
    const entries = await readCatalog(home);
    const previous = entries.find((entry) => entry.alias === alias);
    if (!previous) throw new Error(`Saved Workbench does not exist: ${alias}`);

    const entry = await materializeCatalogEntry({
        home,
        alias,
        source: upgrade.source,
        selector: upgrade.selector,
        manifest: upgrade.manifest,
        files: upgrade.files,
        addedAt: previous.addedAt,
        ...(upgrade.revision ? { revision: upgrade.revision } : {}),
        ...(upgrade.expectedDigest ? { expectedDigest: upgrade.expectedDigest } : {}),
        ...(upgrade.registry ? { registry: upgrade.registry } : {}),
    });
    if (entry.digest === previous.digest) {
        return { previous, entry: previous, changed: false };
    }

    const updated = entries.map((candidate) =>
        candidate.alias === alias ? entry : candidate
    );
    await writeCatalog(home, updated);
    if (!updated.some((candidate) => candidate.digest === previous.digest)) {
        await removeSnapshot(home, previous.digest);
    }
    return { previous, entry, changed: true };
}

async function materializeCatalogEntry(options: {
    home: string;
    alias: string;
    source: string;
    selector: string;
    manifest: WorkbenchManifest;
    files: SnapshotFile[];
    addedAt?: string;
    revision?: string;
    expectedDigest?: string;
    registry?: CatalogRegistryReference;
}): Promise<CatalogEntry> {
    const digest = packageDigest(options.files);
    if (options.expectedDigest && digest !== options.expectedDigest) {
        throw new Error(
            `Registry package digest mismatch: expected ${options.expectedDigest}, received ${digest}`
        );
    }
    const snapshotRoot = join(options.home, 'packages', digest.slice('sha256:'.length));
    const packagePath = join(snapshotRoot, '.workbenches', options.selector);
    await materializeSnapshot(packagePath, options.files);
    const entry: CatalogEntry = {
        alias: options.alias,
        name: options.manifest.name,
        version: options.manifest.version,
        source: options.source,
        selector: options.selector,
        digest,
        packagePath,
        addedAt: options.addedAt ?? new Date().toISOString(),
        ...(options.revision ? { revision: options.revision } : {}),
        ...(options.registry ? { registry: options.registry } : {}),
    };
    return entry;
}

async function materializeSnapshot(
    packagePath: string,
    files: SnapshotFile[]
): Promise<void> {
    if (await stat(packagePath).catch(() => null)) return;
    await mkdir(dirname(packagePath), { recursive: true });
    const staging = join(
        dirname(packagePath),
        `.${basename(packagePath)}.${crypto.randomUUID()}`
    );
    try {
        await mkdir(staging);
        for (const file of files) {
            const destination = join(staging, file.path);
            const fromPackage = relative(staging, destination);
            if (fromPackage.startsWith('..') || isAbsolute(fromPackage)) {
                throw new Error(`Invalid Workbench package file path: ${file.path}`);
            }
            await mkdir(dirname(destination), { recursive: true });
            await writeFile(destination, file.bytes, {
                mode: file.executable ? 0o755 : 0o644,
            });
        }
        await rename(staging, packagePath).catch(async (error) => {
            if (await stat(packagePath).catch(() => null)) return;
            throw error;
        });
    } finally {
        await rm(staging, { recursive: true, force: true });
    }
}

export async function removeFromCatalog(
    home: string,
    alias: string
): Promise<CatalogEntry> {
    const entries = await readCatalog(home);
    const entry = entries.find((candidate) => candidate.alias === alias);
    if (!entry) throw new Error(`Saved Workbench does not exist: ${alias}`);
    const remaining = entries.filter((candidate) => candidate.alias !== alias);
    await writeCatalog(home, remaining);
    if (!remaining.some((candidate) => candidate.digest === entry.digest)) {
        await removeSnapshot(home, entry.digest);
    }
    return entry;
}

async function removeSnapshot(home: string, digest: string): Promise<void> {
    await rm(join(home, 'packages', digest.slice('sha256:'.length)), {
        recursive: true,
        force: true,
    });
}

export function findCatalogEntry(entries: CatalogEntry[], alias: string) {
    return entries.find((entry) => entry.alias === alias);
}

async function writeCatalog(home: string, entries: CatalogEntry[]) {
    await mkdir(home, { recursive: true });
    const path = join(home, 'catalog.json');
    const temporary = join(home, `catalog.${crypto.randomUUID()}.tmp`);
    await writeFile(
        temporary,
        `${JSON.stringify({ version: 1, entries }, null, 2)}\n`,
        { mode: 0o600 }
    );
    await rename(temporary, path);
}

export function packageDigest(files: SnapshotFile[]): string {
    const hash = createHash('sha256');
    for (const file of files.toSorted((left, right) =>
        left.path.localeCompare(right.path)
    )) {
        hash.update(file.path);
        hash.update('\0');
        hash.update(file.executable ? 'x' : '-');
        hash.update('\0');
        hash.update(file.bytes);
        hash.update('\0');
    }
    return `sha256:${hash.digest('hex')}`;
}

async function localPackageFiles(
    directory: string,
    relativePath = ''
): Promise<SnapshotFile[]> {
    const entries = await readdir(join(directory, relativePath), {
        withFileTypes: true,
    });
    const files: SnapshotFile[] = [];
    for (const entry of entries.sort((left, right) =>
        left.name.localeCompare(right.name)
    )) {
        const path = join(relativePath, entry.name);
        if (entry.isDirectory()) {
            files.push(...(await localPackageFiles(directory, path)));
        } else if (entry.isFile()) {
            const details = await lstat(join(directory, path));
            files.push({
                path,
                bytes: await readFile(join(directory, path)),
                executable: Boolean(details.mode & 0o111),
            });
        }
    }
    return files;
}

async function rejectSymlinks(directory: string, relative = ''): Promise<void> {
    for (const entry of await readdir(join(directory, relative))) {
        const path = join(relative, entry);
        const details = await lstat(join(directory, path));
        if (details.isSymbolicLink()) {
            throw new Error(`Workbench packages may not contain symlinks: ${path}`);
        }
        if (details.isDirectory()) await rejectSymlinks(directory, path);
    }
}

function validateAlias(alias: string) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(alias)) {
        throw new Error(`Invalid saved Workbench alias: ${alias}`);
    }
}

function ensurePortablePackage(workbench: ResolvedWorkbench) {
    const paths = [
        workbench.instructionsPath,
        ...workbench.skills.map((skill) => skill.directory),
    ];
    for (const path of paths) {
        const relativePath = relative(workbench.packageDirectory, path);
        if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
            throw new Error(
                'Saved Workbenches must keep instructions and skills inside the package'
            );
        }
    }
}
