import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
        const manifest = JSON.parse(
            await readFile(join(root, 'package.json'), 'utf8')
        ) as { exports: Record<string, string> };
        const subpaths = Object.entries(manifest.exports).filter(
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
