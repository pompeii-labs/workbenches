import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import type { RemoteWorkbenchPackage } from '../sources/index.js';
import type { ResolvedWorkbench, WorkbenchManifest } from '../types.js';
import { WorkbenchPackage } from './package.js';
import { CatalogSnapshots } from './snapshots.js';
import type {
    CatalogEntry,
    CatalogFile,
    CatalogRegistryReference,
    CatalogUpgrade,
    CatalogUpgradeResult,
    SnapshotFile,
} from './types.js';

interface CatalogEntryInput {
    alias: string;
    source: string;
    selector: string;
    manifest: WorkbenchManifest;
    files: SnapshotFile[];
    addedAt?: string;
    revision?: string;
    expectedDigest?: string;
    registry?: CatalogRegistryReference;
}

export class SavedWorkbenchCatalog {
    readonly #snapshots: CatalogSnapshots;

    constructor(readonly home: string) {
        this.#snapshots = new CatalogSnapshots(home);
    }

    async list(): Promise<CatalogEntry[]> {
        const path = join(this.home, 'catalog.json');
        const source = await readFile(path, 'utf8').catch(() => null);
        if (!source) {
            return [];
        }
        const parsed = JSON.parse(source) as Partial<CatalogFile>;
        if (parsed.version !== 1 || !Array.isArray(parsed.entries)) {
            throw new Error(`Unsupported Workbench catalog: ${path}`);
        }
        return parsed.entries;
    }

    async find(alias: string): Promise<CatalogEntry | undefined> {
        return (await this.list()).find((entry) => entry.alias === alias);
    }

    async add(options: {
        alias: string;
        source: string;
        revision?: string;
        workbench: ResolvedWorkbench;
    }): Promise<CatalogEntry> {
        return this.save({
            alias: options.alias,
            source: options.source,
            ...(options.revision ? { revision: options.revision } : {}),
            selector: basename(options.workbench.packageDirectory),
            manifest: options.workbench.manifest,
            files: await new WorkbenchPackage(options.workbench).files(),
        });
    }

    async addRemote(options: {
        alias: string;
        workbench: RemoteWorkbenchPackage;
        expectedDigest?: string;
        registry?: CatalogRegistryReference;
    }): Promise<CatalogEntry> {
        return this.save({
            alias: options.alias,
            source: options.workbench.source,
            revision: options.workbench.revision,
            selector: options.workbench.selector,
            manifest: options.workbench.manifest,
            files: options.workbench.files,
            ...(options.expectedDigest
                ? { expectedDigest: options.expectedDigest }
                : {}),
            ...(options.registry ? { registry: options.registry } : {}),
        });
    }

    async upgrade(
        alias: string,
        upgrade: CatalogUpgrade
    ): Promise<CatalogUpgradeResult> {
        this.validateAlias(alias);
        const entries = await this.list();
        const previous = entries.find((entry) => entry.alias === alias);
        if (!previous) throw new Error(`Saved Workbench does not exist: ${alias}`);

        const entry = await this.materialize({
            alias,
            source: upgrade.source,
            selector: upgrade.selector,
            manifest: upgrade.manifest,
            files: upgrade.files,
            addedAt: previous.addedAt,
            ...(upgrade.revision ? { revision: upgrade.revision } : {}),
            ...(upgrade.expectedDigest
                ? { expectedDigest: upgrade.expectedDigest }
                : {}),
            ...(upgrade.registry ? { registry: upgrade.registry } : {}),
        });
        if (entry.digest === previous.digest) {
            return { previous, entry: previous, changed: false };
        }

        const updated = entries.map((candidate) =>
            candidate.alias === alias ? entry : candidate
        );
        await this.write(updated);
        if (!updated.some((candidate) => candidate.digest === previous.digest)) {
            await this.#snapshots.remove(previous.digest);
        }
        return { previous, entry, changed: true };
    }

    async remove(alias: string): Promise<CatalogEntry> {
        const entries = await this.list();
        const entry = entries.find((candidate) => candidate.alias === alias);
        if (!entry) throw new Error(`Saved Workbench does not exist: ${alias}`);
        const remaining = entries.filter((candidate) => candidate.alias !== alias);
        await this.write(remaining);
        if (!remaining.some((candidate) => candidate.digest === entry.digest)) {
            await this.#snapshots.remove(entry.digest);
        }
        return entry;
    }

    private async save(options: CatalogEntryInput): Promise<CatalogEntry> {
        this.validateAlias(options.alias);
        const entries = await this.list();
        if (entries.some((entry) => entry.alias === options.alias)) {
            throw new Error(`Saved Workbench already exists: ${options.alias}`);
        }
        const entry = await this.materialize(options);
        await this.write([...entries, entry]);
        return entry;
    }

    private async materialize(options: CatalogEntryInput): Promise<CatalogEntry> {
        const snapshot = await this.#snapshots.materialize(
            options.selector,
            options.files,
            options.expectedDigest
        );
        return {
            alias: options.alias,
            name: options.manifest.name,
            version: options.manifest.version,
            source: options.source,
            selector: options.selector,
            digest: snapshot.digest,
            packagePath: snapshot.packagePath,
            addedAt: options.addedAt ?? new Date().toISOString(),
            ...(options.revision ? { revision: options.revision } : {}),
            ...(options.registry ? { registry: options.registry } : {}),
        };
    }

    private async write(entries: CatalogEntry[]): Promise<void> {
        await mkdir(this.home, { recursive: true });
        const path = join(this.home, 'catalog.json');
        const temporary = join(this.home, `catalog.${crypto.randomUUID()}.tmp`);
        await writeFile(
            temporary,
            `${JSON.stringify({ version: 1, entries }, null, 2)}\n`,
            { mode: 0o600 }
        );
        await rename(temporary, path);
    }

    private validateAlias(alias: string): void {
        if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(alias)) {
            throw new Error(`Invalid saved Workbench alias: ${alias}`);
        }
    }
}
