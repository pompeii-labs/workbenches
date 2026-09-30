import { afterAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    type DockerCommandResult,
    DockerRuntimeProvider,
} from '../src/runtimes/docker/index.js';
import { E2BRuntimeProvider } from '../src/runtimes/e2b/index.js';
import {
    LocalRuntimeProvider,
    type RuntimePrepareRequest,
    type RuntimeProvider,
    RuntimeRegistry,
    RuntimeSmoke,
} from '../src/runtimes/index.js';
import type { ResolvedWorkbench } from '../src/types.js';
import {
    type RequirementsHost,
    RequirementsPreflight,
    WorkbenchManifestParser,
    withRuntime,
} from '../src/workbench/index.js';

const root = await mkdtemp(join(tmpdir(), 'runtime-requirements-'));
const packageDirectory = join(root, '.workbenches', 'core');
await mkdir(packageDirectory, { recursive: true });
await writeFile(join(packageDirectory, 'instructions.md'), '# Instructions\n');
afterAll(() => rm(root, { recursive: true, force: true }));

const parser = new WorkbenchManifestParser();

function workbench(
    manifest: Record<string, unknown>,
    runtime?: string
): ResolvedWorkbench {
    const resolved: ResolvedWorkbench = {
        manifestPath: join(packageDirectory, 'workbench.yml'),
        packageDirectory,
        repositoryDirectory: root,
        instructionsPath: join(packageDirectory, 'instructions.md'),
        skills: [],
        manifest: parser.parse({
            spec: 1,
            version: '0.1.0',
            name: 'fixture-core',
            runner: 'opencode',
            model: { id: 'openai/gpt-5.6-terra' },
            instructions: './instructions.md',
            ...manifest,
        }),
    };
    return withRuntime(resolved, runtime);
}

const macArm: RequirementsHost = {
    os: 'macos',
    arch: 'arm64',
    cpus: 8,
    memoryBytes: 16 * 1024 ** 3,
};
const linuxX64: RequirementsHost = {
    os: 'linux',
    arch: 'x64',
    cpus: 2,
    memoryBytes: 4 * 1024 ** 3,
};

function check(
    manifest: Record<string, unknown>,
    runtime: string,
    host: RequirementsHost = macArm,
    options: { allowUncheckedGpu?: boolean } = {}
) {
    return new RequirementsPreflight(host).check(workbench(manifest, runtime), options);
}

const localOnly = { runtimes: { local: {} } };
const withRuntimes = (requirements: Record<string, unknown>) => ({
    requirements,
    runtimes: {
        local: {},
        docker: { image: 'alpine:3.22' },
        e2b: { image: 'alpine:3.22' },
        daytona: { class: 'linux' },
    },
});

describe('local requirements', () => {
    test('passes an unconstrained workbench without checking anything', () => {
        expect(check(localOnly, 'local')).toEqual({
            checked: [],
            applied: [],
            unchecked: [],
        });
    });

    test('checks os against the host', () => {
        const linuxOrMac = withRuntimes({ os: ['linux', 'macos'] });
        expect(check(linuxOrMac, 'local').checked).toEqual(['os macos']);
        expect(() => check(withRuntimes({ os: ['windows'] }), 'local')).toThrow(
            'cannot run on the local runtime: requires os windows but this host is macos'
        );
        expect(() =>
            check(withRuntimes({ os: ['linux', 'windows'] }), 'local')
        ).toThrow('requires os linux or windows but this host is macos');
    });

    test('checks arch against the host', () => {
        expect(check(withRuntimes({ arch: ['arm64'] }), 'local').checked).toEqual([
            'arch arm64',
        ]);
        expect(() => check(withRuntimes({ arch: ['x64'] }), 'local')).toThrow(
            'requires arch x64 but this host is arm64'
        );
    });

    test('checks cpu and memory against the host', () => {
        expect(check(withRuntimes({ cpu: 8, memory_gb: 16 }), 'local').checked).toEqual(
            ['cpu 8', 'memory 16 GiB']
        );
        expect(() => check(withRuntimes({ cpu: 9 }), 'local')).toThrow(
            'requires 9 CPUs but this host has 8'
        );
        expect(() => check(withRuntimes({ memory_gb: 32 }), 'local')).toThrow(
            'requires 32 GiB of memory but this host has 16 GiB'
        );
    });

    test('rounds host memory to the nearest GiB before comparing', () => {
        const reported = (gibibytes: number): RequirementsHost => ({
            ...macArm,
            memoryBytes: Math.floor(gibibytes * 1024 ** 3),
        });
        // A 16 GB Linux host reports about 15.6 GiB and still satisfies 16.
        expect(
            check(withRuntimes({ memory_gb: 16 }), 'local', reported(15.6)).checked
        ).toEqual(['memory 16 GiB']);
        // Just under the rounding midpoint rounds down and is refused.
        expect(() =>
            check(withRuntimes({ memory_gb: 16 }), 'local', reported(15.49))
        ).toThrow('requires 16 GiB of memory but this host has 15 GiB');
    });

    test('refuses a gpu requirement unless it is explicitly accepted', () => {
        expect(() => check(withRuntimes({ gpu: true }), 'local')).toThrow(
            'GPU requirements are not checked on the local runtime'
        );
        expect(
            check(withRuntimes({ gpu: true }), 'local', macArm, {
                allowUncheckedGpu: true,
            }).unchecked
        ).toEqual(['gpu is not checked on the local runtime']);
    });

    test('records disk as unchecked', () => {
        expect(check(withRuntimes({ disk_gb: 50 }), 'local').unchecked).toEqual([
            'disk_gb is not checked on the local runtime',
        ]);
    });
});

describe('docker and e2b requirements', () => {
    test('need an os that includes linux', () => {
        for (const runtime of ['docker', 'e2b']) {
            expect(() => check(withRuntimes({ os: ['macos'] }), runtime)).toThrow(
                `cannot run on the ${runtime} runtime: requires os macos but the ${runtime} runtime provides linux`
            );
            expect(() =>
                check(withRuntimes({ os: ['macos', 'linux'] }), runtime)
            ).not.toThrow();
        }
    });

    test('docker needs the host arch to be allowed', () => {
        expect(() => check(withRuntimes({ arch: ['x64'] }), 'docker')).toThrow(
            'requires arch x64 but the docker runtime runs on arm64'
        );
        expect(check(withRuntimes({ arch: ['arm64'] }), 'docker').checked).toEqual([
            'arch arm64',
        ]);
        expect(
            check(withRuntimes({ arch: ['x64'] }), 'docker', linuxX64).checked
        ).toEqual(['arch x64']);
    });

    test('docker applies cpu and memory as container limits', () => {
        const report = check(withRuntimes({ cpu: 4, memory_gb: 8 }), 'docker');
        expect(report.applied).toEqual(['cpu limit 4', 'memory limit 8 GiB']);
        expect(report.unchecked).toEqual([]);
    });

    test('e2b records arch, cpu, memory, and disk as unchecked', () => {
        const report = check(
            withRuntimes({ arch: ['x64'], cpu: 4, memory_gb: 8, disk_gb: 10 }),
            'e2b'
        );
        expect(report.unchecked).toEqual([
            'arch is not checked on the e2b runtime',
            'cpu is not checked on the e2b runtime',
            'memory_gb is not checked on the e2b runtime',
            'disk_gb is not checked on the e2b runtime',
        ]);
    });

    test('refuse a gpu requirement even when unchecked gpu is accepted', () => {
        for (const runtime of ['docker', 'e2b']) {
            expect(() =>
                check(withRuntimes({ gpu: true }), runtime, macArm, {
                    allowUncheckedGpu: true,
                })
            ).toThrow(`GPU requirements are not supported on the ${runtime} runtime`);
        }
    });
});

describe('daytona requirements', () => {
    const daytona = (daytonaClass: string, requirements: Record<string, unknown>) => ({
        requirements,
        runtimes: { daytona: { class: daytonaClass } },
    });

    test('linux class needs linux or no os constraint', () => {
        expect(() => check(daytona('linux', {}), 'daytona')).not.toThrow();
        expect(() =>
            check(daytona('linux', { os: ['linux', 'macos'] }), 'daytona')
        ).not.toThrow();
        expect(() => check(daytona('linux', { os: ['macos'] }), 'daytona')).toThrow(
            'the linux class provides linux but the Workbench requires macos'
        );
    });

    test('macos class needs macos', () => {
        expect(() =>
            check(daytona('macos', { os: ['macos'] }), 'daytona')
        ).not.toThrow();
        expect(() => check(daytona('macos', {}), 'daytona')).not.toThrow();
        expect(() => check(daytona('macos', { os: ['linux'] }), 'daytona')).toThrow(
            'the macos class provides macos but the Workbench requires linux'
        );
    });

    test('windows class needs windows', () => {
        expect(() =>
            check(daytona('windows', { os: ['windows'] }), 'daytona')
        ).not.toThrow();
        expect(() =>
            check(daytona('windows', { os: ['linux', 'macos'] }), 'daytona')
        ).toThrow('the windows class provides windows');
    });

    test('gpu class needs linux and gpu true', () => {
        expect(() =>
            check(daytona('gpu', { os: ['linux'], gpu: true }), 'daytona')
        ).not.toThrow();
        expect(() => check(daytona('gpu', { gpu: true }), 'daytona')).not.toThrow();
        expect(() => check(daytona('gpu', {}), 'daytona')).toThrow(
            'the gpu class requires gpu: true in requirements'
        );
        expect(() =>
            check(daytona('gpu', { os: ['windows'], gpu: true }), 'daytona')
        ).toThrow('the gpu class provides linux but the Workbench requires windows');
    });

    test('applies cpu, memory, and disk as sandbox resources and cannot check arch', () => {
        expect(
            check(
                daytona('linux', {
                    arch: ['x64'],
                    cpu: 4,
                    memory_gb: 7.5,
                    disk_gb: 20,
                }),
                'daytona'
            )
        ).toEqual({
            checked: ['class linux provides linux'],
            applied: [
                'cpu allocation 4',
                'memory allocation 8 GiB',
                'disk allocation 20 GiB',
            ],
            unchecked: ['arch is not checked on the daytona runtime'],
        });
    });

    test('a gpu requirement needs the gpu class', () => {
        expect(() => check(daytona('linux', { gpu: true }), 'daytona')).toThrow(
            'requirements.gpu is true but the linux class has no GPU'
        );
    });
});

function prepareRequest(
    target: ResolvedWorkbench,
    allowUncheckedGpu = false
): RuntimePrepareRequest {
    return {
        workbench: target,
        workspaceDirectory: root,
        environment: {},
        assets: [
            { path: root, access: 'read-write' },
            { path: packageDirectory, access: 'read-only' },
        ],
        ...(allowUncheckedGpu ? { allowUncheckedGpu: true } : {}),
    };
}

describe('providers apply requirements before preparing', () => {
    test('the local provider refuses an unsatisfied host requirement', async () => {
        const target = workbench(withRuntimes({ os: ['windows'] }), 'local');
        await expect(
            new LocalRuntimeProvider({ host: macArm }).prepare(prepareRequest(target))
        ).rejects.toThrow('requires os windows but this host is macos');
        await expect(
            new LocalRuntimeProvider({ host: macArm }).prepare(
                prepareRequest(workbench(withRuntimes({ os: ['macos'] }), 'local'))
            )
        ).resolves.toBeDefined();
    });

    test('the local provider refuses a gpu requirement the request does not acknowledge', async () => {
        const target = workbench(withRuntimes({ gpu: true }), 'local');
        await expect(
            new LocalRuntimeProvider({ host: macArm }).prepare(prepareRequest(target))
        ).rejects.toThrow('GPU requirements are not checked on the local runtime');
    });

    test('the local provider reports checked requirements from preflight', async () => {
        const runtime = await new LocalRuntimeProvider({
            host: macArm,
            findExecutable: (name) => `/bin/${name}`,
        }).prepare(
            prepareRequest(
                workbench(withRuntimes({ cpu: 2, gpu: true }), 'local'),
                true
            )
        );
        const preflight = await runtime.preflight();
        expect(preflight.requirements).toEqual({
            checked: ['cpu 8'],
            applied: [],
            unchecked: ['gpu is not checked on the local runtime'],
        });
        await runtime.cleanup();
    });

    test('the docker provider refuses before contacting the daemon', async () => {
        const commands: string[][] = [];
        const target = workbench(withRuntimes({ os: ['windows'] }), 'docker');
        await expect(
            new DockerRuntimeProvider({
                findExecutable: () => '/usr/bin/docker',
                command: dockerDouble(commands),
                host: linuxX64,
            }).prepare(prepareRequest(target))
        ).rejects.toThrow('requires os windows but the docker runtime provides linux');
        expect(commands).toEqual([]);
    });

    test('the docker provider limits cpu and memory on every container', async () => {
        const commands: string[][] = [];
        const spawned: string[][] = [];
        const runtime = await new DockerRuntimeProvider({
            findExecutable: () => '/usr/bin/docker',
            command: dockerDouble(commands),
            spawn(command) {
                spawned.push(command);
                return { exited: Promise.resolve(0), kill() {} };
            },
            host: linuxX64,
        }).prepare(
            prepareRequest(
                workbench(
                    withRuntimes({ cpu: 2, memory_gb: 1.5, arch: ['x64'] }),
                    'docker'
                )
            )
        );
        try {
            const preflight = await runtime.preflight();
            expect(preflight.requirements?.applied).toEqual([
                'cpu limit 2',
                'memory limit 1.5 GiB',
            ]);
            runtime.launch({
                command: ['opencode', 'run', 'inspect'],
                cwd: runtime.workspaceDirectory,
                env: runtime.environment,
            });
            for (const command of [
                spawned[0] ?? [],
                commands.findLast((entry) => entry[1] === 'run') ?? [],
            ]) {
                const cpu = command.indexOf('--cpus');
                const memory = command.indexOf('--memory');
                expect(command[cpu + 1]).toBe('2');
                expect(command[memory + 1]).toBe('1536m');
            }
        } finally {
            await runtime.cleanup();
        }
    });

    test('the docker provider refuses a daemon with too few CPUs or too little memory', async () => {
        const provider = (daemon: { cpus: number; memoryBytes: number }) =>
            new DockerRuntimeProvider({
                findExecutable: () => '/usr/bin/docker',
                command: dockerDouble([], daemon),
                host: linuxX64,
            });
        const target = (requirements: Record<string, unknown>) =>
            prepareRequest(workbench(withRuntimes(requirements), 'docker'));

        await expect(
            provider({ cpus: 2, memoryBytes: 16 * 1024 ** 3 }).prepare(
                target({ cpu: 4 })
            )
        ).rejects.toThrow('requires 4 CPUs but the Docker daemon has 2');
        await expect(
            provider({ cpus: 8, memoryBytes: 4 * 1024 ** 3 }).prepare(
                target({ memory_gb: 8 })
            )
        ).rejects.toThrow('requires 8 GiB of memory but the Docker daemon has 4 GiB');
        // A daemon that reports just under nominal still satisfies the requirement.
        const satisfied = await provider({
            cpus: 4,
            memoryBytes: Math.floor(7.7 * 1024 ** 3),
        }).prepare(target({ cpu: 4, memory_gb: 8 }));
        await satisfied.cleanup();
    });

    test('the docker provider does not query the daemon when no limits are declared', async () => {
        const commands: string[][] = [];
        const runtime = await new DockerRuntimeProvider({
            findExecutable: () => '/usr/bin/docker',
            command: dockerDouble(commands),
        }).prepare(
            prepareRequest(
                workbench({ runtimes: { docker: { image: 'alpine:3.22' } } })
            )
        );
        await runtime.cleanup();
        expect(commands.some((command) => command[1] === 'info')).toBe(false);
    });

    test('the docker provider adds no limits when none are declared', async () => {
        const spawned: string[][] = [];
        const runtime = await new DockerRuntimeProvider({
            findExecutable: () => '/usr/bin/docker',
            command: dockerDouble([]),
            spawn(command) {
                spawned.push(command);
                return { exited: Promise.resolve(0), kill() {} };
            },
        }).prepare(
            prepareRequest(
                workbench({ runtimes: { docker: { image: 'alpine:3.22' } } })
            )
        );
        try {
            await runtime.preflight();
            runtime.launch({
                command: ['opencode'],
                cwd: runtime.workspaceDirectory,
                env: runtime.environment,
            });
            expect(spawned[0]).not.toContain('--cpus');
            expect(spawned[0]).not.toContain('--memory');
        } finally {
            await runtime.cleanup();
        }
    });

    test('the e2b provider refuses gpu before creating anything', async () => {
        const target = workbench(withRuntimes({ gpu: true }), 'e2b');
        await expect(
            new E2BRuntimeProvider().prepare(prepareRequest(target))
        ).rejects.toThrow('GPU requirements are not supported on the e2b runtime');
    });

    test('the daytona runtime is registered and needs an image before it contacts anything', async () => {
        const target = workbench({ runtimes: { daytona: { class: 'linux' } } });
        await expect(
            RuntimeRegistry.standard()
                .resolve('daytona')
                .prepare(prepareRequest(target))
        ).rejects.toMatchObject({
            runtime: 'daytona',
            phase: 'prepare',
            message: expect.stringContaining('The daytona runtime needs an image'),
        });
    });
});

describe('smoke runtime selection', () => {
    function recorder(name: string, calls: string[]): RuntimeProvider {
        return {
            name,
            async prepare(request) {
                calls.push(`${name}:${request.workbench.selectedRuntime ?? 'default'}`);
                throw new Error(`${name} prepared`);
            },
        };
    }

    const multi = {
        runtimes: { local: {}, docker: { image: 'alpine:3.22' } },
    };

    test('prepares the first declared runtime by default', async () => {
        const calls: string[] = [];
        await expect(
            new RuntimeSmoke({
                workbench: workbench(multi),
                workspaceDirectory: root,
                environment: { OPENROUTER_API_KEY: 'fixture-key' },
                registry: new RuntimeRegistry([
                    recorder('local', calls),
                    recorder('docker', calls),
                ]),
            }).check()
        ).rejects.toThrow('local prepared');
        expect(calls).toEqual(['local:default']);
    });

    test('prepares the runtime named with --runtime', async () => {
        const calls: string[] = [];
        await expect(
            new RuntimeSmoke({
                workbench: workbench(multi),
                runtime: 'docker',
                workspaceDirectory: root,
                environment: { OPENROUTER_API_KEY: 'fixture-key' },
                registry: new RuntimeRegistry([
                    recorder('local', calls),
                    recorder('docker', calls),
                ]),
            }).check()
        ).rejects.toThrow('docker prepared');
        expect(calls).toEqual(['docker:docker']);
    });

    test('lists the declared runtimes for an unknown name', async () => {
        const calls: string[] = [];
        await expect(
            new RuntimeSmoke({
                workbench: workbench(multi),
                runtime: 'e2b',
                workspaceDirectory: root,
                registry: new RuntimeRegistry([recorder('local', calls)]),
            }).check()
        ).rejects.toThrow(
            'Workbench fixture-core does not declare runtime: e2b. Declared runtimes: local, docker'
        );
        expect(calls).toEqual([]);
    });

    test('refuses unsatisfied requirements before preparing a runtime', async () => {
        const calls: string[] = [];
        await expect(
            new RuntimeSmoke({
                workbench: workbench(withRuntimes({ gpu: true })),
                workspaceDirectory: root,
                registry: new RuntimeRegistry([recorder('local', calls)]),
            }).check()
        ).rejects.toThrow('GPU requirements are not checked on the local runtime');
        expect(calls).toEqual([]);
    });

    test('accepts an unchecked gpu requirement when told to', async () => {
        const calls: string[] = [];
        await expect(
            new RuntimeSmoke({
                workbench: workbench(withRuntimes({ gpu: true })),
                allowUncheckedGpu: true,
                workspaceDirectory: root,
                environment: { OPENROUTER_API_KEY: 'fixture-key' },
                registry: new RuntimeRegistry([recorder('local', calls)]),
            }).check()
        ).rejects.toThrow('local prepared');
        expect(calls).toEqual(['local:default']);
    });
});

function dockerDouble(
    commands: string[][],
    daemon: { cpus: number; memoryBytes: number } = {
        cpus: 8,
        memoryBytes: 16 * 1024 ** 3,
    }
) {
    return async (command: string[]): Promise<DockerCommandResult> => {
        commands.push(command);
        const ok = (stdout = ''): DockerCommandResult => ({
            code: 0,
            stdout,
            stderr: '',
        });
        if (command[1] === 'version') return ok('28.1.1\n');
        if (command[1] === 'info') return ok(`${daemon.cpus} ${daemon.memoryBytes}\n`);
        if (command[1] === 'image' && command[2] === 'pull')
            return ok('sha256:local\n');
        if (command[1] === 'image' && command[2] === 'inspect') {
            return ok(
                `${JSON.stringify({
                    Id: `sha256:${'b'.repeat(64)}`,
                    RepoDigests: [`alpine@sha256:${'a'.repeat(64)}`],
                })}\n`
            );
        }
        if (command[1] === 'volume' && command[2] === 'create') {
            return ok(`${command[3] ?? ''}\n`);
        }
        if (command[1] === 'run') {
            if (command.includes('command -v "$1" 2>/dev/null')) {
                return ok(`/usr/local/bin/${command.at(-1)}\n`);
            }
            return ok();
        }
        if (command[1] === 'container') return ok();
        throw new Error(`Unexpected Docker command: ${command.join(' ')}`);
    };
}
