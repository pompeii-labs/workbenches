import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { RunnerRegistry } from '../src/runners/registry.js';
import type { PreparedRuntime } from '../src/runtimes/contracts.js';
import type { ResolvedWorkbench } from '../src/types.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories
            .splice(0)
            .map((directory) => rm(directory, { recursive: true, force: true }))
    );
});

describe('runner registry', () => {
    test('stages a writable native config copy without changing the pinned package', async () => {
        const workbench = await fixture();
        const runnerConfigPath = join(workbench.packageDirectory, 'opencode.json');
        await writeFile(runnerConfigPath, '{"share":"disabled"}\n');
        workbench.manifest.runner = 'opencode';
        workbench.runnerConfigPath = runnerConfigPath;

        const runner = await RunnerRegistry.standard().prepare(workbench, {});

        expect(
            runner.assets.some((asset) => asset.path === runnerConfigPath)
        ).toBeFalse();
        expect(runner.assets).toContainEqual({
            path: expect.stringContaining('workbench-opencode-'),
            access: 'read-write',
        });
        const runtime = preparedRuntime(workbench);
        const configuration = {
            runner: 'opencode',
            canonicalModel: 'openai/gpt-5.6-terra',
            provider: 'openai',
            nativeProvider: 'openai',
            nativeModel: 'gpt-5.6-terra',
            model: 'openai/gpt-5.6-terra',
            routes: [
                {
                    provider: 'openai',
                    model: 'gpt-5.6-terra',
                    value: 'openai/gpt-5.6-terra',
                },
            ],
        };
        const invocation = runner.build(runtime, 'inspect', configuration);
        const native = runner.native(runtime, ['opencode', 'auth', 'list']);

        expect(invocation.command).toContain('openai/gpt-5.6-terra');
        expect(native.env).toMatchObject({
            OPENCODE_CONFIG: '/runtime/opencode.json',
            OPENCODE_CONFIG_DIR: expect.stringContaining(
                '/runtime/workbench-opencode-'
            ),
        });

        const staged = runner.assets[0]?.path;
        if (!staged) throw new Error('Missing staged configuration');
        const copy = join(staged, 'native', 'opencode.json');
        expect(await readFile(copy, 'utf8')).toBe('{"share":"disabled"}\n');
        await writeFile(
            copy,
            '{"$schema":"https://opencode.ai/config.json","share":"disabled"}\n'
        );
        expect(await readFile(runnerConfigPath, 'utf8')).toBe('{"share":"disabled"}\n');
        expect(await readFile(join(staged, 'native', 'instructions.md'), 'utf8')).toBe(
            await readFile(workbench.instructionsPath, 'utf8')
        );

        await runner.cleanup();
        await expect(stat(copy)).rejects.toThrow();
    });

    test('keeps single-file native config references relative to its copied package', async () => {
        const workbench = await fixture();
        const configDirectory = join(workbench.packageDirectory, 'runner');
        await mkdir(configDirectory);
        const config = join(configDirectory, 'settings.json');
        const content =
            '{"plugin":["./plugin.ts"],"instructions":["{file:../instructions.md}"]}';
        await writeFile(config, content);
        await writeFile(
            join(configDirectory, 'plugin.ts'),
            'export default async () => ({})\n'
        );
        workbench.manifest.runner = 'opencode';
        workbench.runnerConfigPath = config;
        const runner = await RunnerRegistry.standard().prepare(workbench, {});
        try {
            const stage = runner.assets[0]?.path;
            if (!stage) throw new Error('Missing staged configuration');
            const copy = join(stage, 'native', 'runner', 'settings.json');
            expect(await readFile(copy, 'utf8')).toBe(content);
            expect(await readFile(resolve(dirname(copy), './plugin.ts'), 'utf8')).toBe(
                await readFile(join(configDirectory, 'plugin.ts'), 'utf8')
            );
            expect(
                await readFile(resolve(dirname(copy), '../instructions.md'), 'utf8')
            ).toBe(await readFile(workbench.instructionsPath, 'utf8'));
        } finally {
            await runner.cleanup();
        }
    });

    test('binds Pi credentials inside Docker and rejects a changed runner', async () => {
        const workbench = await fixture();
        const runner = await RunnerRegistry.standard().prepare(workbench, {});
        const runtime = preparedRuntime(workbench);
        const invocation = runner.native(runtime, [
            'pi',
            'auth',
            'check',
            '--provider',
            'openai',
        ]);
        const run = runner.build(runtime, 'inspect', {
            runner: 'pi',
            canonicalModel: 'openai/gpt-5.6-terra',
            provider: 'openai',
            nativeProvider: 'openai-codex',
            nativeModel: 'gpt-5.6-terra',
            model: 'openai-codex/gpt-5.6-terra',
            routes: [
                {
                    provider: 'openai',
                    model: 'gpt-5.6-terra',
                    value: 'openai/gpt-5.6-terra',
                },
            ],
        });

        expect(invocation.command.slice(0, 2)).toEqual(['/bin/sh', '-c']);
        expect(invocation.command.slice(-5)).toEqual([
            'pi',
            'auth',
            'check',
            '--provider',
            'openai',
        ]);
        expect(invocation.env).toMatchObject({
            PI_CODING_AGENT_DIR: '/tmp/workbench-pi',
            WORKBENCH_PI_CONFIG_DIR: expect.stringContaining('/runtime/'),
        });
        expect(run.command).toContain('openai-codex');
        expect(run.command[run.command.indexOf('--skill') + 1]).toMatch(
            /^\/runtime\/workbench-pi-.+\/skills\/review$/
        );
        expect(
            runner.native(preparedRuntime(workbench, 'local'), [
                'pi',
                'auth',
                'check',
                '--provider',
                'openai',
            ])
        ).toMatchObject({
            command: ['pi', 'auth', 'check', '--provider', 'openai'],
            cwd: '/workspace',
        });
        expect(() =>
            runner.build(runtime, 'inspect', {
                runner: 'opencode',
                canonicalModel: 'openai/gpt-5.6-terra',
                provider: 'openai',
                nativeProvider: 'openai',
                nativeModel: 'gpt-5.6-terra',
                model: 'openai/gpt-5.6-terra',
                routes: [
                    {
                        provider: 'openai',
                        model: 'gpt-5.6-terra',
                        value: 'openai/gpt-5.6-terra',
                    },
                ],
            })
        ).toThrow('Effective runner opencode does not match Workbench runner pi');

        await runner.cleanup();
    });

    test('rejects an unsupported runner before staging any assets', async () => {
        const workbench = await fixture();
        workbench.manifest.runner = 'unknown';

        await expect(RunnerRegistry.standard().prepare(workbench, {})).rejects.toThrow(
            'Unsupported runner: unknown'
        );
    });
});

async function fixture(): Promise<ResolvedWorkbench> {
    const root = await mkdtemp(join(tmpdir(), 'runner-registry-'));
    temporaryDirectories.push(root);
    const packageDirectory = join(root, '.workbenches', 'core');
    const skillDirectory = join(packageDirectory, 'skills', 'review');
    await mkdir(skillDirectory, { recursive: true });
    const instructionsPath = join(packageDirectory, 'instructions.md');
    await writeFile(instructionsPath, '# Instructions\n');
    await writeFile(join(skillDirectory, 'SKILL.md'), '# Review\n');
    return {
        manifestPath: join(packageDirectory, 'workbench.yml'),
        packageDirectory,
        repositoryDirectory: root,
        instructionsPath,
        skills: [
            {
                name: 'review',
                directory: skillDirectory,
                manifestPath: join(skillDirectory, 'SKILL.md'),
            },
        ],
        manifest: {
            spec: 0,
            version: '0.1.0',
            name: 'pi-core',
            runner: 'pi',
            model: {
                id: 'openai/gpt-5.6-terra',
                routes: [{ provider: 'openai' }],
            },
            instructions: './instructions.md',
            skills: ['./skills/review'],
            tools: [],
            mcps: [],
            env: {},
            runtime: 'docker',
            image: 'example/pi:latest',
        },
    };
}

function preparedRuntime(
    workbench: ResolvedWorkbench,
    name = 'docker'
): PreparedRuntime {
    return {
        name,
        nativeAuthentication: 'persistent',
        workbench,
        workspaceDirectory: '/workspace',
        environment: {
            WORKBENCH_CREDENTIALS_DIR: '/workbench-credentials',
        },
        workspaces: [],
        pathFor: (path) => `/runtime/${path.split('/').at(-1)}`,
        preflight: () => Promise.reject(new Error('unused')),
        execute: () => Promise.reject(new Error('unused')),
        interact: () => Promise.reject(new Error('unused')),
        launch: () => ({ exited: Promise.resolve(0) }),
        launchSession: () => ({ exited: Promise.resolve(0) }),
        launchService: () => ({
            process: { exited: Promise.resolve(0) },
            resolveUrl: async (url) => url,
        }),
        cancel: () => {},
        cleanup: async () => {},
    };
}
