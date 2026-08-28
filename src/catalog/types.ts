import type { WorkbenchManifest } from '../types.js';

export interface SnapshotFile {
    path: string;
    bytes: Uint8Array;
    executable: boolean;
}

export interface CatalogRegistryReference {
    url: string;
    publisher: string;
    workbench: string;
    version_id: string;
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

export interface CatalogFile {
    version: 1;
    entries: CatalogEntry[];
}
