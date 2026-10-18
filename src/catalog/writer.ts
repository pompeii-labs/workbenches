import { basename } from 'node:path';

import type { RemoteWorkbenchPackage } from '../sources/index.js';
import type { ResolvedWorkbench, WorkbenchManifest } from '../types.js';
import type { SnapshotGuard } from './guard.js';
import { WorkbenchPackage } from './package.js';
import type { SavedWorkbenchCatalog } from './saved.js';
import type { CatalogSnapshots } from './snapshots.js';
import type {
    CatalogEntry,
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
    ref?: string;
}

/**
 * The saved Workbenches that live in shared snapshots: adding, upgrading and
 * removing them records or drops a reference to a snapshot, which the guard
 * serializes across processes.
 */
export class CatalogWriter {
    constructor(
        private readonly catalog: Pick<
            SavedWorkbenchCatalog,
            'list' | 'write' | 'remove' | 'validateAlias'
        >,
        private readonly snapshots: Pick<CatalogSnapshots, 'materialize'>,
        private readonly guard: Pick<SnapshotGuard, 'exclusive' | 'release'>
    ) {}

    /**
     * Drops a shared snapshot once no saved Workbench and no session refers to
     * it. Called when a session that owned a reference is removed.
     */
    async releaseSnapshot(digest: string | undefined): Promise<void> {
        if (!digest) return;
        await this.guard.release(digest, async () =>
            (await this.catalog.list()).some((entry) => entry.digest === digest)
        );
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
        ref?: string;
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
            ...(options.ref ? { ref: options.ref } : {}),
        });
    }

    async upgrade(
        alias: string,
        upgrade: CatalogUpgrade
    ): Promise<CatalogUpgradeResult> {
        this.catalog.validateAlias(alias);
        const entries = await this.catalog.list();
        const previous = entries.find((entry) => entry.alias === alias);
        if (!previous) throw new Error(`Saved Workbench does not exist: ${alias}`);

        const entry = await this.guard.exclusive(
            WorkbenchPackage.digest(upgrade.files),
            async () => {
                const materialized = await this.materialize({
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
                    ...(upgrade.ref
                        ? { ref: upgrade.ref }
                        : previous.ref
                          ? { ref: previous.ref }
                          : {}),
                });
                if (materialized.digest !== previous.digest)
                    await this.catalog.write(
                        entries.map((candidate) =>
                            candidate.alias === alias ? materialized : candidate
                        )
                    );
                return materialized;
            }
        );
        if (entry.digest === previous.digest) {
            return { previous, entry: previous, changed: false };
        }
        await this.releaseSnapshot(previous.digest);
        return { previous, entry, changed: true };
    }

    async remove(alias: string): Promise<CatalogEntry> {
        const entry = await this.catalog.remove(alias);
        if (!entry.localPath) await this.releaseSnapshot(entry.digest);
        return entry;
    }

    private async save(options: CatalogEntryInput): Promise<CatalogEntry> {
        this.catalog.validateAlias(options.alias);
        const entries = await this.catalog.list();
        const previous = entries.find((entry) => entry.alias === options.alias);
        if (previous) {
            const sameSource =
                !previous.localPath &&
                previous.source === options.source &&
                previous.selector === options.selector &&
                previous.registry?.url === options.registry?.url &&
                previous.registry?.publisher === options.registry?.publisher &&
                previous.registry?.workbench === options.registry?.workbench &&
                previous.ref === options.ref;
            const digest = WorkbenchPackage.digest(options.files);
            if (options.expectedDigest && digest !== options.expectedDigest)
                throw new Error('Registry package digest mismatch');
            if (sameSource && previous.digest === digest) return previous;
            throw new Error(
                sameSource
                    ? `Saved Workbench already exists: ${options.alias}. Run wb upgrade ${options.alias} to update it.`
                    : `Saved Workbench already exists: ${options.alias}. Choose another alias with --as.`
            );
        }
        return this.guard.exclusive(
            WorkbenchPackage.digest(options.files),
            async () => {
                const entry = await this.materialize(options);
                await this.catalog.write([...entries, entry]);
                return entry;
            }
        );
    }

    private async materialize(options: CatalogEntryInput): Promise<CatalogEntry> {
        const snapshot = await this.snapshots.materialize(
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
            ...(options.ref ? { ref: options.ref } : {}),
        };
    }
}
