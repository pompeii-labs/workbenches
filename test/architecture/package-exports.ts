import { join } from 'node:path';

const root = join(import.meta.dir, '..', '..');

/**
 * A subpath's export: a file, or TypeScript declarations beside the source Bun
 * runs. `source` comes first so the repository's own tsc, which sets that
 * custom condition, checks the source and never a stale declaration build.
 */
export type ExportEntry = string | { source: string; types: string; default: string };

export const packageManifest = (await Bun.file(join(root, 'package.json')).json()) as {
    exports: Record<string, ExportEntry>;
    files: string[];
};

/** The file a runtime loads for each subpath: the source for a TypeScript export. */
export const runtimeExports: Record<string, string> = Object.fromEntries(
    Object.entries(packageManifest.exports).map(([subpath, entry]) => [
        subpath,
        typeof entry === 'string' ? entry : entry.default,
    ])
);
