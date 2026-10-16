import type { CatalogRegistryReference } from '../catalog/types.js';
import { RowReader } from '../database/rowreader.js';
import type { WorkbenchWorkspaceBinding } from '../types.js';

/** Checks for the JSON columns that run and session rows share. */
export function isStoredWorkspaces(
    value: unknown
): value is WorkbenchWorkspaceBinding[] {
    return (
        Array.isArray(value) &&
        value.every(
            (entry) =>
                RowReader.isRecord(entry) &&
                typeof entry.name === 'string' &&
                typeof entry.path === 'string' &&
                (entry.access === 'read-only' || entry.access === 'read-write')
        )
    );
}

export function isStoredRegistry(value: unknown): value is CatalogRegistryReference {
    return (
        RowReader.isRecord(value) &&
        typeof value.url === 'string' &&
        typeof value.publisher === 'string' &&
        typeof value.workbench === 'string' &&
        typeof value.version_id === 'string' &&
        (value.visibility === undefined ||
            value.visibility === 'public' ||
            value.visibility === 'private')
    );
}
