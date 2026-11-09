import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { packageManifest, runtimeExports } from './package-exports.js';

const root = join(import.meta.dir, '..', '..');
const name = '@pompeii-labs/workbench';

/**
 * A consumer that imports only the embeddable subpaths typechecks them in its own
 * program, usually with the DOM lib. The CLI's registry, catalog, and terminal
 * code must not leak into that program through type imports.
 */
describe('type boundary', () => {
    let directory: string | undefined;

    afterAll(async () => {
        if (directory) await rm(directory, { recursive: true, force: true });
    });

    test('typechecks every embeddable subpath under the DOM lib', async () => {
        const subpaths = Object.entries(runtimeExports).filter(
            ([subpath, target]) =>
                subpath !== '.' &&
                subpath !== './package.json' &&
                target.endsWith('.ts')
        );

        const paths: Record<string, string[]> = {};
        const imports: string[] = [];
        for (const [index, [subpath, target]] of subpaths.entries()) {
            const specifier = `${name}/${subpath.slice(2)}`;
            paths[specifier] = [join(root, target)];
            imports.push(`import * as m${index} from '${specifier}';`);
        }
        imports.push(
            `export const all = [${subpaths.map((_, index) => `m${index}`).join(', ')}];`
        );

        directory = await mkdtemp(join(tmpdir(), 'workbench-types-'));
        await writeFile(join(directory, 'consumer.ts'), `${imports.join('\n')}\n`);
        await writeFile(
            join(directory, 'tsconfig.json'),
            JSON.stringify({
                compilerOptions: {
                    target: 'ES2023',
                    module: 'ESNext',
                    moduleResolution: 'bundler',
                    lib: ['ES2023', 'DOM'],
                    types: ['bun'],
                    typeRoots: [join(root, 'node_modules', '@types')],
                    strict: true,
                    noEmit: true,
                    skipLibCheck: true,
                    resolveJsonModule: true,
                    allowImportingTsExtensions: true,
                    baseUrl: directory,
                    paths,
                },
                files: ['consumer.ts'],
            })
        );

        const child = Bun.spawn(
            [
                process.execPath,
                join(root, 'node_modules', 'typescript', 'bin', 'tsc'),
                '--noEmit',
                '-p',
                directory,
            ],
            { cwd: root, stdout: 'pipe', stderr: 'pipe' }
        );
        const [output, errors, code] = await Promise.all([
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
            child.exited,
        ]);
        expect(`${output}${errors}`.trim()).toBe('');
        expect(code).toBe(0);
    }, 120_000);
});

/** A tsc host checks against the shipped declarations, with no Bun types and no source. */
describe('published declarations', () => {
    let directory: string | undefined;

    afterAll(async () => {
        if (directory) await rm(directory, { recursive: true, force: true });
    });

    async function tsc(args: string[]): Promise<{ code: number; output: string }> {
        const child = Bun.spawn(
            [
                process.execPath,
                join(root, 'node_modules', 'typescript', 'bin', 'tsc'),
                ...args,
            ],
            { cwd: root, stdout: 'pipe', stderr: 'pipe' }
        );
        const [output, errors, code] = await Promise.all([
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
            child.exited,
        ]);
        return { code, output: `${output}${errors}`.trim() };
    }

    test('type-checks a host without Bun types and without engine source', async () => {
        directory = await mkdtemp(join(tmpdir(), 'workbench-declarations-'));
        const installed = join(directory, 'node_modules', ...name.split('/'));
        const built = await tsc([
            '-p',
            join(root, 'tsconfig.build.json'),
            '--outDir',
            join(installed, 'dist', 'types'),
        ]);
        expect(built.output).toBe('');
        expect(built.code).toBe(0);
        await writeFile(
            join(installed, 'package.json'),
            JSON.stringify({
                name,
                type: 'module',
                exports: packageManifest.exports,
            })
        );

        const subpaths = Object.keys(packageManifest.exports).filter(
            (subpath) => subpath !== './package.json'
        );
        const imports = subpaths.map(
            (subpath, index) =>
                `import * as m${index} from '${subpath === '.' ? name : `${name}/${subpath.slice(2)}`}';`
        );
        imports.push(
            `export const all = [${subpaths.map((_, index) => `m${index}`).join(', ')}];`
        );
        await writeFile(join(directory, 'host.ts'), `${imports.join('\n')}\n`);
        await writeFile(
            join(directory, 'tsconfig.json'),
            JSON.stringify({
                compilerOptions: {
                    target: 'ES2022',
                    module: 'NodeNext',
                    moduleResolution: 'NodeNext',
                    strict: true,
                    skipLibCheck: true,
                    noEmit: true,
                    types: [],
                },
                files: ['host.ts'],
            })
        );
        await writeFile(
            join(directory, 'package.json'),
            JSON.stringify({ name: 'host', type: 'module' })
        );

        const checked = await tsc(['-p', directory]);
        expect(checked.output).toBe('');
        expect(checked.code).toBe(0);
    }, 120_000);
});
