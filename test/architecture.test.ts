import { describe, expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';
import ts from 'typescript';
import { RunnerRegistry } from '../src/runners/registry.js';
import { importCycles, valueImports } from './architecture/imports.js';

const root = join(import.meta.dir, '..');
const source = join(root, 'src');

describe('engine architecture', () => {
    test('keeps the static value-import graph acyclic', async () => {
        const sources = new Map(
            await Promise.all(
                (await sourceFiles(source)).map(
                    async (file) =>
                        [relative(source, file), await readFile(file, 'utf8')] as const
                )
            )
        );
        expect(importCycles(valueImports(sources))).toEqual([]);
    });

    test('keeps engine domains independent of CLI presentation', async () => {
        const sources = new Map(
            await Promise.all(
                (await sourceFiles(source)).map(
                    async (file) =>
                        [relative(source, file), await readFile(file, 'utf8')] as const
                )
            )
        );
        const presentation = (file: string) =>
            file === 'cli.ts' ||
            file.startsWith('commands/') ||
            file.startsWith('rendering/');
        const violations: string[] = [];
        for (const [file, imports] of valueImports(sources)) {
            if (file === 'index.ts' || presentation(file)) continue;
            for (const target of imports) {
                if (presentation(target) || target === 'index.ts')
                    violations.push(`${file} -> ${target}`);
            }
        }
        expect(violations).toEqual([]);
    });

    test('keeps runner names out of shared code', async () => {
        const registered = RunnerRegistry.standard().list();
        const folders = registered.map((runner) => `src/runners/${runner.name}/`);
        // A runner is named by its name or by its display name.
        const names = registered.flatMap((runner) => [runner.name, runner.displayName]);
        // Each entry is a deliberate exception, matched by its exact line. Shared
        // code otherwise reaches runners through RunnerRegistry and the members
        // they declare.
        const allowed = [
            // The public configureOpenCode helper builds an OpenCode configuration.
            { path: 'src/models/routing.ts', line: "runner: 'opencode'," },
            // A new Workbench records the OpenCode runner unless told otherwise.
            { path: 'src/commands/init.ts', line: "default: 'opencode'," },
            // The label of the OpenCode model provider, which shares the runner's name.
            { path: 'src/connections/targets.ts', line: "opencode: 'OpenCode'," },
        ];
        const used = new Set<(typeof allowed)[number]>();
        const violations: string[] = [];
        for (const file of await sourceFiles(source)) {
            const path = relative(root, file);
            // A runner's own folder names it freely.
            if (folders.some((folder) => path.startsWith(folder))) continue;
            // The registry and the domain entrypoint import each concrete runner.
            const registers =
                path === 'src/runners/registry.ts' || path === 'src/runners/index.ts';
            const lines = (await readFile(file, 'utf8')).split('\n');
            for (const [index, line] of lines.entries()) {
                const named = runnerNames(line, names, registers);
                if (named.length === 0) continue;
                const exception = allowed.find(
                    (entry) => entry.path === path && entry.line === line.trim()
                );
                if (exception) {
                    used.add(exception);
                    continue;
                }
                violations.push(
                    `${path}:${index + 1} names runner ${named.join(', ')}; shared code must reach runners through RunnerRegistry`
                );
            }
        }
        expect(violations).toEqual([]);
        // An exception that no longer matches its line must be removed, not kept.
        expect(allowed.filter((entry) => !used.has(entry))).toEqual([]);
    });

    test('distinguishes type-only edges from executable imports and barrel exports', () => {
        const sources = new Map([
            [
                'a.ts',
                "import type { B } from './b.js'; export { type B } from './b.js';",
            ],
            ['b.ts', "import { type A } from './a.js';"],
        ]);
        expect(importCycles(valueImports(sources))).toEqual([]);
        sources.set('a.ts', "import './b.js';");
        sources.set('b.ts', "export * from './a.js';");
        expect(importCycles(valueImports(sources))).toEqual([['a.ts', 'b.ts']]);
    });

    test('keeps only public and executable entrypoints at the source root', async () => {
        const entries = await readdir(source, { withFileTypes: true });
        const files = entries
            .filter((entry) => entry.isFile())
            .map((entry) => entry.name)
            .sort();

        expect(files).toEqual([
            'cli.ts',
            'index.ts',
            'storage.ts',
            'types.ts',
            'user-agent.ts',
        ]);
    });

    test('keeps handwritten production modules below the hard size limit', async () => {
        const oversized: string[] = [];
        for (const file of await sourceFiles(source)) {
            const lines = (await readFile(file, 'utf8')).split('\n').length;
            if (lines > 700) {
                oversized.push(`${relative(root, file)} (${lines} lines)`);
            }
        }

        expect(oversized).toEqual([]);
    });

    test('exposes an explicit package API', async () => {
        const entrypoint = await readFile(join(source, 'index.ts'), 'utf8');
        expect(entrypoint).not.toMatch(/export\s+\*/u);
    });

    test('builds session and run storage paths only in the files store', async () => {
        const violations: string[] = [];
        for (const file of await sourceFiles(source)) {
            const path = relative(root, file);
            // The legacy layout names the old file-based directories to leave them alone.
            if (path.startsWith('src/files/') || path.startsWith('src/legacy/'))
                continue;
            const syntax = ts.createSourceFile(
                path,
                await readFile(file, 'utf8'),
                ts.ScriptTarget.Latest,
                true
            );
            const visit = (node: ts.Node): void => {
                if (ts.isCallExpression(node) && pathBuilder(node)) {
                    const literals = node.arguments.map((argument) =>
                        ts.isStringLiteralLike(argument) ? argument.text : undefined
                    );
                    for (const [index, text] of literals.entries()) {
                        // Authoring keeps its own, unrelated `runs` index.
                        if (
                            (text === 'sessions' || text === 'runs') &&
                            literals[index - 1] !== 'authoring'
                        )
                            violations.push(`${path}: ${text}`);
                    }
                }
                ts.forEachChild(node, visit);
            };
            visit(syntax);
        }

        expect(violations).toEqual([]);
    });

    test('does not bundle model catalog generation into the engine', async () => {
        const packageJson = JSON.parse(
            await readFile(join(root, 'package.json'), 'utf8')
        ) as { scripts?: Record<string, string> };
        const modelScripts = Object.keys(packageJson.scripts ?? {}).filter((name) =>
            name.startsWith('models:')
        );

        expect(modelScripts).toEqual([]);
        expect(
            await Bun.file(join(source, 'models', 'model-catalog.lock.json')).exists()
        ).toBe(false);
    });
});

function pathBuilder(call: ts.CallExpression): boolean {
    const callee = call.expression;
    const name = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : undefined;
    return name === 'join' || name === 'resolve';
}

/**
 * The runner names a line's string literals contain, as the whole literal or
 * as one of its path segments, such as `'pi'`, `case 'opencode':`, or
 * `'opencode/auth.json'`. Prose that mentions a runner inside a longer string
 * is not a name. With `skipImports`, module specifiers are ignored.
 */
function runnerNames(line: string, runners: string[], skipImports: boolean): string[] {
    const names = new Set<string>();
    for (const literal of line.matchAll(
        /'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`/gu
    )) {
        const before = line.slice(0, literal.index);
        if (skipImports && /\b(?:from|import)\s*\(?\s*$/u.test(before)) continue;
        for (const segment of literal[0].slice(1, -1).split('/')) {
            if (runners.includes(segment)) names.add(segment);
        }
    }
    return [...names];
}

async function sourceFiles(directory: string): Promise<string[]> {
    const files: string[] = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
            files.push(...(await sourceFiles(path)));
        } else if (['.ts', '.tsx'].includes(extname(entry.name))) {
            files.push(path);
        }
    }
    return files;
}
