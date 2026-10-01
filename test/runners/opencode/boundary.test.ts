import { describe, expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';

import {
    externalValueImports,
    reachable,
    valueImports,
} from '../../architecture/imports.js';

const source = join(import.meta.dir, '..', '..', '..', 'src');

/** The session driver and event translation run on any JavaScript runtime with fetch. */
const portable = [
    'server.ts',
    'session.ts',
    'turn.ts',
    'events.ts',
    'question.ts',
    'input.ts',
    'children.ts',
    'timing.ts',
].map((file) => `runners/opencode/${file}`);

const localFilesystem = /^(node:)?(fs|os)(\/|$)/;

describe('OpenCode adapter I/O boundary', () => {
    test('session driver and event translation import no local filesystem module', async () => {
        const sources = await sourceMap();
        const reached = reachable(valueImports(sources), portable);
        const external = externalValueImports(sources);
        const violations: string[] = [];
        for (const [file, path] of reached) {
            for (const specifier of external.get(file) ?? []) {
                if (localFilesystem.test(specifier)) {
                    violations.push(`${[...path, specifier].join(' -> ')}`);
                }
            }
        }
        expect(violations).toEqual([]);
        expect([...reached.keys()]).toEqual(expect.arrayContaining(portable));
    });

    test('flags a local filesystem import reached through a relative import', () => {
        const sources = new Map([
            ['a.ts', "import { b } from './b.js';"],
            ['b.ts', "import { readFile } from 'node:fs/promises';"],
            ['c.ts', "import type { Stats } from 'node:fs';"],
        ]);
        const reached = reachable(valueImports(sources), ['a.ts']);
        const external = externalValueImports(sources);
        const hits = [...reached.keys()].flatMap((file) =>
            (external.get(file) ?? []).filter((specifier) =>
                localFilesystem.test(specifier)
            )
        );
        expect(hits).toEqual(['node:fs/promises']);
        expect(external.get('c.ts')).toEqual([]);
    });
});

async function sourceMap(): Promise<Map<string, string>> {
    const files = await sourceFiles(source);
    return new Map(
        await Promise.all(
            files.map(
                async (file) =>
                    [relative(source, file), await readFile(file, 'utf8')] as const
            )
        )
    );
}

async function sourceFiles(directory: string): Promise<string[]> {
    const files: string[] = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) files.push(...(await sourceFiles(path)));
        else if (['.ts', '.tsx'].includes(extname(entry.name))) files.push(path);
    }
    return files;
}
