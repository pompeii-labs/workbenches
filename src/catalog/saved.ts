import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

import type { ResolvedWorkbench } from '../types.js';
import { WorkbenchPackage } from './package.js';
import type { CatalogEntry, CatalogFile } from './types.js';

/**
 * The saved Workbench list in `<home>/catalog.json`. It reads, and registers
 * local packages. Snapshots of remote packages are the `CatalogWriter`'s.
 */
export class SavedWorkbenchCatalog {
    constructor(readonly home: string) {}

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

    async addLocal(options: {
        alias?: string;
        workbench: ResolvedWorkbench;
    }): Promise<CatalogEntry> {
        const localPath = resolve(options.workbench.packageDirectory);
        const entries = await this.list();
        const sameDirectory = entries.find((entry) => entry.localPath === localPath);
        const alias =
            options.alias ?? sameDirectory?.alias ?? options.workbench.manifest.name;
        this.validateAlias(alias);
        const previous = entries.find((entry) => entry.alias === alias);
        // Explicit re-add is the migration boundary for frozen v1 local entries.
        const legacyLocal =
            previous &&
            !previous.registry &&
            previous.source.startsWith('/') &&
            (previous.source === localPath ||
                join(previous.source, '.workbenches', previous.selector) === localPath);
        if (previous && previous.localPath !== localPath && !legacyLocal)
            throw new Error(
                `Saved Workbench already exists: ${alias}. Choose another alias with --as.`
            );
        const files = await new WorkbenchPackage(options.workbench).files();
        const digest = WorkbenchPackage.digest(files);
        if (previous?.localPath === localPath && previous.digest === digest)
            return previous;
        const entry: CatalogEntry = {
            alias,
            name: options.workbench.manifest.name,
            version: options.workbench.manifest.version,
            source: localPath,
            selector: basename(localPath),
            localPath,
            packagePath: localPath,
            digest,
            addedAt: previous?.addedAt ?? new Date().toISOString(),
        };
        await this.write([
            ...entries.filter((candidate) => candidate.alias !== alias),
            entry,
        ]);
        return entry;
    }

    /** Drops the alias. A remote entry's snapshot is the `CatalogWriter`'s to release. */
    async remove(alias: string): Promise<CatalogEntry> {
        const entries = await this.list();
        const entry = entries.find((candidate) => candidate.alias === alias);
        if (!entry) throw new Error(`Saved Workbench does not exist: ${alias}`);
        await this.write(entries.filter((candidate) => candidate.alias !== alias));
        return entry;
    }

    async write(entries: CatalogEntry[]): Promise<void> {
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

    validateAlias(alias: string): void {
        if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(alias)) {
            throw new Error(`Invalid saved Workbench alias: ${alias}`);
        }
    }
}
