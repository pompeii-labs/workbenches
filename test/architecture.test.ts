import { describe, expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';

const root = join(import.meta.dir, '..');
const source = join(root, 'src');

describe('engine architecture', () => {
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
            'tui.ts',
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
