import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');

/**
 * Subpaths a host on a runtime with only `fetch` bundles for the browser. Each
 * must build without pulling in a filesystem, process, or compression module.
 */
const portable: Record<string, string> = {
    './runtimes/daytona': 'src/runtimes/daytona/index.ts',
    './runners/opencode/adapter': 'src/runners/opencode/adapter.ts',
    './runners/opencode/runner': 'src/runners/opencode/runner.ts',
    './models': 'src/models/index.ts',
    './outcomes': 'src/outcomes/core.ts',
    './workbench/manifest': 'src/workbench/manifest.ts',
    './workbench/requirements': 'src/workbench/requirements.ts',
    './runtimes/contracts': 'src/runtimes/contracts.ts',
    './runtimes/staging': 'src/runtimes/staging/index.ts',
};

/** Modules that do not exist on every runtime. */
const forbidden = [
    'node:fs',
    'node:fs/promises',
    'node:os',
    'node:zlib',
    'node:stream',
    'node:stream/promises',
    'node:child_process',
];

/** Small built-ins every mainstream JavaScript runtime provides. */
const allowed = ['node:path', 'node:util', 'node:crypto', 'node:buffer', 'node:events'];

async function bundle(entry: string): Promise<string> {
    const child = Bun.spawn(
        [
            process.execPath,
            join(import.meta.dir, 'architecture', 'bundle.ts'),
            join(root, entry),
        ],
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

function builtins(output: string): string[] {
    const found = new Set<string>();
    for (const match of output.matchAll(/["'`](node:[a-z_/]+)["'`]/g)) {
        if (match[1]) found.add(match[1]);
    }
    return [...found].toSorted();
}

describe('bundle boundary', () => {
    for (const [subpath, entry] of Object.entries(portable)) {
        test(`${subpath} bundles for the browser without a local runtime module`, async () => {
            const output = await bundle(entry);
            const used = builtins(output);
            expect(used.filter((name) => forbidden.includes(name))).toEqual([]);
            expect(used.filter((name) => !allowed.includes(name))).toEqual([]);
            // Printed so a run lists each subpath as clean.
            console.log(
                `bundle-boundary: ${subpath} clean (${output.length} bytes, built-ins: ${used.join(', ') || 'none'})`
            );
        });
    }

    test('flags a forbidden module when one is reachable', () => {
        expect(builtins('import { readFile } from "node:fs/promises";')).toEqual([
            'node:fs/promises',
        ]);
        expect(builtins('import("node:os");')).toEqual(['node:os']);
        expect(builtins('import { join } from "node:path";')).toEqual(['node:path']);
    });

    test('every checked entry is exported by the package', async () => {
        const manifest = JSON.parse(
            await Bun.file(join(root, 'package.json')).text()
        ) as { exports: Record<string, string> };
        // The manifest and requirements modules are exposed under short names.
        const aliases: Record<string, string> = {
            './workbench/manifest': './manifest',
            './workbench/requirements': './requirements',
        };
        for (const [subpath, entry] of Object.entries(portable)) {
            expect(manifest.exports[aliases[subpath] ?? subpath], `${subpath}`).toBe(
                `./${entry}`
            );
        }
    });
});
