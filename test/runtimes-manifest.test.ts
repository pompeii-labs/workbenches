import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ValidateFunction } from 'ajv';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { fullFormats } from 'ajv-formats/dist/formats.js';

import type { ResolvedWorkbench, WorkbenchManifest } from '../src/types.js';
import {
    declaredRuntimeNames,
    requirementsOf,
    selectedRuntime,
    Workbench,
    WorkbenchManifestParser,
    withRuntime,
} from '../src/workbench/index.js';

const base = {
    spec: 1,
    version: '0.1.0',
    name: 'fixture-core',
    runner: 'opencode',
    model: { id: 'openai/gpt-5.6-terra' },
    instructions: './instructions.md',
};

const parser = new WorkbenchManifestParser();

const compiled = new Map<number, Promise<ValidateFunction>>();

function schemaValidator(spec: number): Promise<ValidateFunction> {
    let validator = compiled.get(spec);
    if (!validator) {
        validator = readFile(
            join(import.meta.dir, '..', 'schemas', `v${spec}`, 'workbench.schema.json'),
            'utf8'
        ).then((source) => {
            const ajv = new Ajv2020({ allErrors: true });
            ajv.addFormat('uri', fullFormats.uri);
            return ajv.compile(JSON.parse(source));
        });
        compiled.set(spec, validator);
    }
    return validator;
}

function parses(document: Record<string, unknown>): boolean {
    try {
        parser.parse(document);
        return true;
    } catch {
        return false;
    }
}

type Case = [name: string, extra: Record<string, unknown>, spec?: 0 | 1];

const valid: Case[] = [
    ['spec 0 local runtime', { runtime: 'local' }, 0],
    [
        'spec 0 docker runtime with image',
        { runtime: 'docker', image: 'alpine:3.22' },
        0,
    ],
    [
        'spec 0 docker host engine',
        {
            runtime: 'docker',
            image: 'alpine:3.22',
            docker: { engine: { mode: 'host' } },
        },
        0,
    ],
    ['runtimes local', { runtimes: { local: {} } }],
    ['runtimes local with no value', { runtimes: { local: null } }],
    [
        'runtimes docker with a published image',
        { runtimes: { docker: { image: 'alpine:3.22' } } },
    ],
    [
        'runtimes docker with a local build',
        {
            runtimes: {
                docker: {
                    image: { build: './Dockerfile.workbench', context: '../..' },
                },
            },
        },
    ],
    [
        'runtimes docker with a host engine',
        {
            runtimes: {
                docker: {
                    image: 'alpine:3.22',
                    docker: { engine: { mode: 'host' } },
                },
            },
        },
    ],
    ['runtimes e2b', { runtimes: { e2b: { image: 'alpine:3.22' } } }],
    ['runtimes daytona class', { runtimes: { daytona: { class: 'gpu' } } }],
    [
        'runtimes daytona class with an image',
        { runtimes: { daytona: { class: 'windows', image: 'example/win:1' } } },
    ],
    [
        'several runtimes',
        {
            runtimes: {
                local: {},
                docker: { image: 'alpine:3.22' },
                e2b: { image: 'alpine:3.22' },
                daytona: { class: 'linux' },
            },
        },
    ],
    [
        'every requirement',
        {
            runtimes: { local: {} },
            requirements: {
                os: ['linux', 'macos'],
                arch: ['x64', 'arm64'],
                cpu: 4,
                memory_gb: 7.5,
                disk_gb: 20,
                gpu: true,
            },
        },
    ],
    ['empty requirements', { runtimes: { local: {} }, requirements: {} }],
];

const invalid: Case[] = [
    ['spec 0 without a runtime', {}, 0],
    ['spec 0 with runtimes', { runtime: 'local', runtimes: { local: {} } }, 0],
    ['spec 0 with requirements', { runtime: 'local', requirements: {} }, 0],
    ['spec 1 without runtimes', {}],
    ['spec 1 with the singular runtime', { runtime: 'local' }],
    ['spec 1 with runtime and runtimes', { runtime: 'local', runtimes: { local: {} } }],
    [
        'spec 1 with a top-level image',
        { image: 'alpine:3.22', runtimes: { docker: { image: 'alpine:3.22' } } },
    ],
    [
        'spec 1 with a top-level docker',
        {
            docker: { engine: { mode: 'host' } },
            runtimes: { docker: { image: 'alpine:3.22' } },
        },
    ],
    ['empty runtimes', { runtimes: {} }],
    ['unknown provider', { runtimes: { kubernetes: {} } }],
    ['local with configuration', { runtimes: { local: { image: 'alpine:3.22' } } }],
    ['local that is a string', { runtimes: { local: 'yes' } }],
    ['docker without an image', { runtimes: { docker: {} } }],
    ['docker with no value', { runtimes: { docker: null } }],
    ['e2b without an image', { runtimes: { e2b: {} } }],
    [
        'e2b with a docker engine',
        {
            runtimes: {
                e2b: { image: 'alpine:3.22', docker: { engine: { mode: 'host' } } },
            },
        },
    ],
    ['daytona without a class', { runtimes: { daytona: {} } }],
    ['daytona with an unknown class', { runtimes: { daytona: { class: 'tpu' } } }],
    [
        'host engine mode other than host',
        {
            runtimes: {
                docker: {
                    image: 'alpine:3.22',
                    docker: { engine: { mode: 'isolated' } },
                },
            },
        },
    ],
    [
        'host engine on a spec 0 local runtime',
        { runtime: 'local', docker: { engine: { mode: 'host' } } },
        0,
    ],
    ['unknown os', { runtimes: { local: {} }, requirements: { os: ['plan9'] } }],
    ['empty os', { runtimes: { local: {} }, requirements: { os: [] } }],
    [
        'repeated os',
        { runtimes: { local: {} }, requirements: { os: ['linux', 'linux'] } },
    ],
    ['unknown arch', { runtimes: { local: {} }, requirements: { arch: ['riscv'] } }],
    ['empty arch', { runtimes: { local: {} }, requirements: { arch: [] } }],
    ['zero cpu', { runtimes: { local: {} }, requirements: { cpu: 0 } }],
    ['fractional cpu', { runtimes: { local: {} }, requirements: { cpu: 1.5 } }],
    ['zero memory', { runtimes: { local: {} }, requirements: { memory_gb: 0 } }],
    ['negative disk', { runtimes: { local: {} }, requirements: { disk_gb: -1 } }],
    ['non-boolean gpu', { runtimes: { local: {} }, requirements: { gpu: 'yes' } }],
    ['unknown requirement', { runtimes: { local: {} }, requirements: { tpu: true } }],
];

describe('manifest schemas', () => {
    test('spec 0 keeps its alpha shape and spec 1 is a separate schema', async () => {
        const read = async (spec: number) =>
            JSON.parse(
                await readFile(
                    join(
                        import.meta.dir,
                        '..',
                        'schemas',
                        `v${spec}`,
                        'workbench.schema.json'
                    ),
                    'utf8'
                )
            ) as {
                $id: string;
                $comment?: string;
                required: string[];
                properties: Record<string, { const?: number }>;
            };
        const v0 = await read(0);
        const v1 = await read(1);
        expect(v0.$id).toContain('/schemas/v0/');
        expect(v0.$comment).toBeUndefined();
        expect(v0.required).toContain('runtime');
        expect(v0.properties.spec).toEqual({ const: 0 });
        expect(Object.keys(v0.properties)).not.toContain('runtimes');
        expect(Object.keys(v0.properties)).not.toContain('requirements');
        expect(v1.$id).toContain('/schemas/v1/');
        expect(v1.required).toContain('runtimes');
        expect(v1.required).not.toContain('runtime');
        expect(v1.properties.spec).toEqual({ const: 1 });
        for (const legacy of ['runtime', 'image', 'docker']) {
            expect(Object.keys(v1.properties)).not.toContain(legacy);
        }
    });

    test.each(valid)(
        'accepts %s in the schema and the parser',
        async (_name, extra, spec = 1) => {
            const validate = await schemaValidator(spec);
            const document = { ...base, spec, ...extra };
            expect(validate(document)).toBe(true);
            expect(parses(document)).toBe(true);
        }
    );

    test.each(invalid)(
        'rejects %s in the schema and the parser',
        async (_name, extra, spec = 1) => {
            const validate = await schemaValidator(spec);
            const document = { ...base, spec, ...extra };
            expect(validate(document)).toBe(false);
            expect(parses(document)).toBe(false);
        }
    );
});

describe('runtime entry values', () => {
    test('an empty local entry parses as no configuration', () => {
        const manifest = parser.parse({ ...base, runtimes: { local: null } });
        expect(manifest.runtimes).toEqual({ local: {} });
    });

    test('a wrong type says an object or an empty value is expected', () => {
        expect(() => parser.parse({ ...base, runtimes: { local: 'yes' } })).toThrow(
            'runtimes.local must be an object or an empty value'
        );
        expect(() => parser.parse({ ...base, runtimes: { local: [] } })).toThrow(
            'runtimes.local must be an object or an empty value'
        );
    });
});

describe('manifest parser dispatch', () => {
    test('accepts spec 0 and spec 1 and rejects any other spec', () => {
        expect(parser.parse({ ...base, spec: 0, runtime: 'local' }).spec).toBe(0);
        expect(parser.parse({ ...base, spec: 1, runtimes: { local: {} } }).spec).toBe(
            1
        );
        for (const spec of [2, -1, '1', undefined, null]) {
            expect(() =>
                parser.parse({ ...base, spec, runtimes: { local: {} } })
            ).toThrow(
                `Manifest spec ${String(spec)} is not supported by this engine; upgrade wb`
            );
        }
    });

    test('names spec 1 when the singular form is used in it', () => {
        expect(() => parser.parse({ ...base, runtime: 'local' })).toThrow(
            'Spec 1 manifests declare runtimes, not runtime'
        );
        expect(() =>
            parser.parse({
                ...base,
                image: 'alpine:3.22',
                docker: {},
                runtimes: { docker: { image: 'alpine:3.22' } },
            })
        ).toThrow('Spec 1 manifests declare runtimes, not image, docker');
        expect(() => parser.parse({ ...base })).toThrow(
            'runtimes is required in spec 1'
        );
    });

    test('keeps requirements and runtimes out of spec 0', () => {
        expect(() =>
            parser.parse({
                ...base,
                spec: 0,
                runtime: 'local',
                runtimes: { local: {} },
            })
        ).toThrow('Unknown manifest field: runtimes');
        expect(() =>
            parser.parse({ ...base, spec: 0, runtime: 'local', requirements: {} })
        ).toThrow('Unknown manifest field: requirements');
    });
});

describe('manifest runtimes parser', () => {
    test('normalizes a spec 0 runtime into a one-entry runtimes map', () => {
        const sugar = parser.parse({
            ...base,
            spec: 0,
            runtime: 'docker',
            image: 'ghcr.io/example/workbench:0.4.0',
            docker: { engine: { mode: 'host' } },
        });
        const explicit = parser.parse({
            ...base,
            runtimes: {
                docker: {
                    image: 'ghcr.io/example/workbench:0.4.0',
                    docker: { engine: { mode: 'host' } },
                },
            },
        });

        expect(sugar.runtimes).toEqual(explicit.runtimes);
        expect(sugar.requirements).toEqual(explicit.requirements);
        expect(sugar.runtimes).toEqual({
            docker: {
                image: 'ghcr.io/example/workbench:0.4.0',
                docker: { engine: { mode: 'host' } },
            },
        });
    });

    test('keeps the draft 0 fields readable when the singular form is used', () => {
        const manifest = parser.parse({
            ...base,
            spec: 0,
            runtime: 'docker',
            image: { build: './Dockerfile.workbench' },
        });
        expect(manifest.runtime).toBe('docker');
        expect(manifest.image).toEqual({ build: './Dockerfile.workbench' });
        expect(manifest.runtimes).toEqual({
            docker: { image: { build: './Dockerfile.workbench' } },
        });
    });

    test('does not add draft 0 fields to the runtimes form', () => {
        const manifest = parser.parse({ ...base, runtimes: { local: {} } });
        expect(manifest.runtime).toBeUndefined();
        expect(manifest.image).toBeUndefined();
        expect(manifest.docker).toBeUndefined();
    });

    test('keeps runtimes in declaration order', () => {
        const manifest = parser.parse({
            ...base,
            runtimes: {
                e2b: { image: 'alpine:3.22' },
                local: {},
                docker: { image: 'alpine:3.22' },
            },
        });
        expect(Object.keys(manifest.runtimes ?? {})).toEqual([
            'e2b',
            'local',
            'docker',
        ]);
        expect(declaredRuntimeNames(manifest)).toEqual(['e2b', 'local', 'docker']);
    });

    test('rejects unknown providers naming the known ones', () => {
        expect(() => parser.parse({ ...base, runtimes: { kubernetes: {} } })).toThrow(
            'Unknown runtime provider: kubernetes. Known providers: local, docker, e2b, daytona'
        );
    });

    test('applies requirement defaults', () => {
        expect(parser.parse({ ...base, runtimes: { local: {} } }).requirements).toEqual(
            { gpu: false }
        );
        expect(
            parser.parse({ ...base, spec: 0, runtime: 'local' }).requirements
        ).toEqual({ gpu: false });
        expect(
            parser.parse({
                ...base,
                runtimes: { local: {} },
                requirements: { os: ['linux'], cpu: 2, memory_gb: 4 },
            }).requirements
        ).toEqual({ os: ['linux'], cpu: 2, memory_gb: 4, gpu: false });
    });

    test('describes each rejected requirement', () => {
        const attempt = (requirements: unknown) => () =>
            parser.parse({ ...base, runtimes: { local: {} }, requirements });
        expect(attempt({ os: ['plan9'] })).toThrow(
            'requirements.os entries must be one of linux, macos, windows'
        );
        expect(attempt({ arch: [] })).toThrow(
            'requirements.arch must be a non-empty array'
        );
        expect(attempt({ cpu: 1.5 })).toThrow(
            'requirements.cpu must be a positive integer'
        );
        expect(attempt({ memory_gb: 0 })).toThrow(
            'requirements.memory_gb must be a positive number'
        );
        expect(attempt({ gpu: 'yes' })).toThrow('requirements.gpu must be a boolean');
        expect(attempt({ tpu: true })).toThrow('Unknown requirements field: tpu');
    });
});

describe('runtime selection', () => {
    function workbench(manifest: Record<string, unknown>): ResolvedWorkbench {
        return {
            manifestPath: '/repo/.workbenches/core/workbench.yml',
            packageDirectory: '/repo/.workbenches/core',
            repositoryDirectory: '/repo',
            instructionsPath: '/repo/.workbenches/core/instructions.md',
            skills: [],
            manifest: parser.parse({ ...base, ...manifest }),
        };
    }

    test('uses the first declared runtime by default', () => {
        const target = workbench({
            runtimes: { docker: { image: 'alpine:3.22' }, local: {} },
        });
        expect(selectedRuntime(target)).toEqual({
            name: 'docker',
            image: 'alpine:3.22',
        });
    });

    test('selects a declared runtime by name', () => {
        const target = withRuntime(
            workbench({
                runtimes: { docker: { image: 'alpine:3.22' }, local: {} },
            }),
            'local'
        );
        expect(selectedRuntime(target)).toEqual({ name: 'local' });
    });

    test('keeps the current selection when no name is given', () => {
        const target = withRuntime(
            workbench({ runtimes: { docker: { image: 'a' }, local: {} } }),
            'local'
        );
        expect(withRuntime(target).selectedRuntime).toBe('local');
    });

    test('lists the declared runtimes when the name is unknown', () => {
        const target = workbench({
            runtimes: { local: {}, docker: { image: 'alpine:3.22' } },
        });
        expect(() => withRuntime(target, 'e2b')).toThrow(
            'Workbench fixture-core does not declare runtime: e2b. Declared runtimes: local, docker'
        );
    });

    test('resolves hand-built manifests that only carry the singular form', () => {
        const manifest = {
            spec: 0,
            version: '0.1.0',
            name: 'legacy',
            runner: 'opencode',
            model: { id: 'openai/gpt-5.6-terra' },
            instructions: './instructions.md',
            skills: [],
            tools: [],
            mcps: [],
            env: {},
            runtime: 'docker',
            image: 'alpine:3.22',
        } satisfies WorkbenchManifest;
        const target: ResolvedWorkbench = {
            manifestPath: '/repo/.workbenches/core/workbench.yml',
            packageDirectory: '/repo/.workbenches/core',
            repositoryDirectory: '/repo',
            instructionsPath: '/repo/.workbenches/core/instructions.md',
            skills: [],
            manifest,
        };
        expect(selectedRuntime(target)).toEqual({
            name: 'docker',
            image: 'alpine:3.22',
        });
        expect(requirementsOf(manifest)).toEqual({ gpu: false });
    });
});

describe('runtimes on disk', () => {
    const directories: string[] = [];
    afterEach(async () => {
        await Promise.all(
            directories
                .splice(0)
                .map((directory) => rm(directory, { recursive: true, force: true }))
        );
    });

    async function load(runtimes: string) {
        const root = await mkdtemp(join(tmpdir(), 'workbench-runtimes-'));
        directories.push(root);
        const packageDirectory = join(root, '.workbenches', 'core');
        await mkdir(packageDirectory, { recursive: true });
        await writeFile(join(packageDirectory, 'instructions.md'), '# core\n');
        await writeFile(
            join(packageDirectory, 'workbench.yml'),
            [
                'spec: 1',
                'version: 0.1.0',
                'name: fixture-core',
                'runner: opencode',
                'model:',
                '  id: openai/gpt-5.6-terra',
                'instructions: ./instructions.md',
                runtimes,
                '',
            ].join('\n')
        );
        return Workbench.load(packageDirectory);
    }

    test('loads a runtimes manifest with requirements from YAML', async () => {
        const workbench = await load(
            [
                'requirements:',
                '  os: [linux]',
                '  cpu: 2',
                'runtimes:',
                '  docker:',
                '    image: alpine:3.22',
                '  local: {}',
            ].join('\n')
        );
        expect(Object.keys(workbench.manifest.runtimes ?? {})).toEqual([
            'docker',
            'local',
        ]);
        expect(workbench.manifest.requirements).toEqual({
            os: ['linux'],
            cpu: 2,
            gpu: false,
        });
        expect(selectedRuntime(workbench).name).toBe('docker');
    });

    test('keeps every declared local image build inside the repository', async () => {
        await expect(
            load(
                [
                    'runtimes:',
                    '  local: {}',
                    '  docker:',
                    '    image:',
                    '      build: ../../../Dockerfile',
                ].join('\n')
            )
        ).rejects.toThrow(
            'runtimes.docker.image.build must remain inside the repository'
        );
    });
});
