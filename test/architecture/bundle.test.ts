import { describe, expect, test } from 'bun:test';
import { builtinModules } from 'node:module';
import { join } from 'node:path';

const root = join(import.meta.dir, '..', '..');

/**
 * Every subpath in the package `exports` map is portable unless it is listed
 * here. A portable subpath bundles without a filesystem, process, stream, or
 * zlib module, so a host that has none can import it. The bundle may reach
 * only these built-in modules, and a host must provide them:
 * `node:path`, `node:crypto`, `node:util`, `node:buffer`, and `node:events`.
 * Today the portable subpaths reach `node:path` and `node:util`. The rest of
 * what they need is global: web `crypto`, `fetch`, and the Compression Streams
 * API. These tests do not run the bundles in another runtime.
 */

/** Subpaths that read or write disk, spawn processes, or wire the CLI. Each must reach a forbidden module. */
const diskBacked = [
    '.',
    './outcomes/disk',
    './runners/files/disk',
    './runtimes',
    './runtimes/e2b',
    './runtimes/assets/disk',
];

/** Portable subpaths that hold only types and interfaces, so they bundle to nothing. */
const typeOnly = [
    './types',
    './runners/files',
    './runtimes/contracts',
    './runtimes/e2b/contracts',
    './runtimes/assets',
];

/** Built-in modules that do not exist on every runtime. */
const forbidden = [
    'node:fs',
    'node:fs/promises',
    'node:os',
    'node:zlib',
    'node:stream',
    'node:stream/promises',
    'node:child_process',
];

/** Built-in modules a host must provide. */
const allowed = ['node:path', 'node:util', 'node:crypto', 'node:buffer', 'node:events'];

const manifest = (await Bun.file(join(root, 'package.json')).json()) as {
    exports: Record<string, string>;
};
const subpaths = Object.entries(manifest.exports).filter(([, entry]) =>
    entry.endsWith('.ts')
);
const portable = subpaths.filter(([subpath]) => !diskBacked.includes(subpath));

async function bundle(entry: string): Promise<string> {
    const child = Bun.spawn(
        [process.execPath, join(import.meta.dir, 'bundle.ts'), join(root, entry)],
        { cwd: root, stdout: 'pipe', stderr: 'pipe' }
    );
    const [output, errors, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
    ]);
    if (code !== 0) throw new Error(`Bundling ${entry} failed:\n${errors}`);
    return output;
}

const bareNames = builtinModules
    .filter((name) => !name.startsWith('_'))
    .toSorted((left, right) => right.length - left.length)
    .join('|');
const prefixed = /["'`](node:[a-z_/]+)["'`]/g;
const bare = new RegExp(
    `(?:\\bfrom|\\bimport|\\brequire|\\b__require)\\s*\\(?\\s*["'\`](${bareNames})["'\`]`,
    'g'
);

/** The built-in modules a bundle imports, with a bare `fs` named as `node:fs`. */
function builtins(output: string): string[] {
    const found = new Set<string>();
    for (const match of output.matchAll(prefixed)) {
        if (match[1]) found.add(match[1]);
    }
    for (const match of output.matchAll(bare)) {
        if (match[1]) found.add(`node:${match[1]}`);
    }
    return [...found].toSorted();
}

describe('bundle boundary', () => {
    for (const [subpath, entry] of portable) {
        test(`${subpath} bundles without a filesystem, process, or compression module`, async () => {
            const output = await bundle(entry);
            const used = builtins(output);
            expect(used.filter((name) => forbidden.includes(name))).toEqual([]);
            expect(used.filter((name) => !allowed.includes(name))).toEqual([]);
            if (typeOnly.includes(subpath)) expect(output.trim()).toBe('');
            // Printed so a run lists each subpath as clean.
            console.log(
                `bundle: ${subpath} clean (${output.length} bytes, built-ins: ${used.join(', ') || 'none'})`
            );
        });
    }

    for (const subpath of diskBacked) {
        test(`${subpath} is disk-backed and reaches a forbidden module`, async () => {
            const entry = manifest.exports[subpath];
            if (!entry) throw new Error(`${subpath} is not exported`);
            const used = builtins(await bundle(entry));
            expect(used.filter((name) => forbidden.includes(name))).not.toEqual([]);
        });
    }

    test('every classified subpath is exported by the package', () => {
        for (const subpath of [...diskBacked, ...typeOnly]) {
            expect(manifest.exports[subpath], subpath).toBeString();
        }
        for (const subpath of typeOnly) expect(diskBacked).not.toContain(subpath);
    });

    test('flags a built-in module however it is imported', () => {
        expect(builtins('import { readFile } from "node:fs/promises";')).toEqual([
            'node:fs/promises',
        ]);
        expect(builtins('import("node:os");')).toEqual(['node:os']);
        expect(builtins('import { join } from "node:path";')).toEqual(['node:path']);
        expect(builtins('import fs from "fs";')).toEqual(['node:fs']);
        expect(builtins('const { join } = require("path");')).toEqual(['node:path']);
        expect(builtins('var x = __require("child_process");')).toEqual([
            'node:child_process',
        ]);
        expect(builtins('import("zlib"); import("stream/promises");')).toEqual([
            'node:stream/promises',
            'node:zlib',
        ]);
        expect(builtins('const kind = "path"; log("fs", "os");')).toEqual([]);
    });
});
