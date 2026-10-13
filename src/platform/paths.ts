import native, { posix, win32 } from 'node:path';

/** Paths belong to their runtime, which can differ from the CLI host. */
export function pathStyle(path: string): typeof posix {
    if (/^[a-z]:[\\/]/i.test(path) || path.startsWith('\\\\')) return win32;
    return path.startsWith('/') ? posix : native;
}

export function join(...paths: string[]): string {
    return pathStyle(paths[0] ?? '').join(...paths);
}
export function resolve(...paths: string[]): string {
    return pathStyle(paths[0] ?? '').resolve(...paths);
}
export function relative(from: string, to: string): string {
    return pathStyle(from).relative(from, to);
}
export function dirname(path: string): string {
    return pathStyle(path).dirname(path);
}
export function basename(path: string): string {
    return pathStyle(path).basename(path);
}
export function isAbsolute(path: string): boolean {
    return posix.isAbsolute(path) || win32.isAbsolute(path);
}
