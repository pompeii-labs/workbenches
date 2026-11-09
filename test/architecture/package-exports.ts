import { join } from 'node:path';

const root = join(import.meta.dir, '..', '..');

export type ExportEntry = string | { source: string; types: string; default: string };

export const packageManifest = (await Bun.file(join(root, 'package.json')).json()) as {
    exports: Record<string, ExportEntry>;
    files: string[];
};

export const runtimeExports: Record<string, string> = Object.fromEntries(
    Object.entries(packageManifest.exports).map(([subpath, entry]) => [
        subpath,
        typeof entry === 'string' ? entry : entry.default,
    ])
);
