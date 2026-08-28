import { afterEach, describe, expect, test } from 'bun:test';
import {
    lstat,
    mkdir,
    mkdtemp,
    readFile,
    readlink,
    rm,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stagePiConfig } from '../src/runners/pi/assets.js';
import {
    buildPiInvocation,
    buildPiRpcInvocation,
    piCredentialCommand,
    publicPiInvocation,
} from '../src/runners/pi/invocation.js';
import type { ResolvedWorkbench } from '../src/types.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories
            .splice(0)
            .map((directory) => rm(directory, { recursive: true, force: true }))
    );
});

describe('Pi adapter translation', () => {
    test('builds deterministic JSON and RPC invocations from one effective model', async () => {
        const workbench = await fixture();
        const config = await stagePiConfig(workbench);
        temporaryDirectories.push(config.directory);

        const oneShot = buildPiInvocation(
            workbench,
            'inspect',
            { OPENAI_API_KEY: 'credential' },
            workbench.repositoryDirectory,
            'openai/gpt-5.6-terra',
            config.directory
        );
        const interactive = buildPiRpcInvocation(
            workbench,
            { OPENAI_API_KEY: 'credential' },
            workbench.repositoryDirectory,
            'openai/gpt-5.6-terra',
            config.directory
        );
        const stagedSkill = join(config.directory, 'skills', 'review');

        expect(oneShot.command).toEqual([
            'pi',
            '--mode',
            'json',
            '--print',
            '--no-session',
            '--no-context-files',
            '--provider',
            'openai',
            '--model',
            'gpt-5.6-terra',
            '--skill',
            stagedSkill,
            'inspect',
        ]);
        expect(interactive.command.slice(0, 3)).toEqual(['pi', '--mode', 'rpc']);
        expect(interactive.command).toContain('openai');
        expect(interactive.command).toContain('gpt-5.6-terra');
        expect(interactive.command).toContain(stagedSkill);
        expect(oneShot.env).toMatchObject({
            OPENAI_API_KEY: 'credential',
            PI_CODING_AGENT_DIR: config.directory,
        });
    });

    test('merges packaged and Workbench system instructions', async () => {
        const workbench = await fixture();
        const config = await mkdtemp(join(tmpdir(), 'pi-package-'));
        temporaryDirectories.push(config);
        workbench.runnerConfigPath = config;
        await writeFile(join(config, 'APPEND_SYSTEM.md'), '# Package settings\n');
        await writeFile(join(config, 'models.json'), '{"providers":{}}\n');

        const staged = await stagePiConfig(workbench, {});
        temporaryDirectories.push(staged.directory);

        expect(await readFile(join(staged.directory, 'APPEND_SYSTEM.md'), 'utf8')).toBe(
            '# Package settings\n\n# Workbench instructions\n'
        );
        expect(await readFile(join(staged.directory, 'models.json'), 'utf8')).toBe(
            '{"providers":{}}\n'
        );
    });

    test('links the native credential file without reading or copying it', async () => {
        const workbench = await fixture();
        const native = await mkdtemp(join(tmpdir(), 'pi-native-'));
        temporaryDirectories.push(native);
        const credentials = join(native, 'auth.json');
        await writeFile(credentials, '{"secret":"must-stay-native"}\n');

        const staged = await stagePiConfig(workbench, {
            PI_CODING_AGENT_DIR: native,
        });
        temporaryDirectories.push(staged.directory);
        const linked = join(staged.directory, 'auth.json');

        expect((await lstat(linked)).isSymbolicLink()).toBeTrue();
        expect(await readlink(linked)).toBe(credentials);
    });

    test('stages declared skills into the runner configuration', async () => {
        const workbench = await fixture();
        const staged = await stagePiConfig(workbench, {});
        temporaryDirectories.push(staged.directory);

        expect(
            await readFile(
                join(staged.directory, 'skills', 'review', 'SKILL.md'),
                'utf8'
            )
        ).toBe('# Review\n');
    });

    test('fails explicitly when a Workbench declares MCP transport', async () => {
        const workbench = await fixture();
        workbench.manifest.mcps = [
            {
                name: 'docs',
                transport: 'http',
                url: 'https://example.com/mcp',
                headers: {},
            },
        ];
        expect(() => buildPiInvocation(workbench, 'inspect')).toThrow(
            'Pi does not provide a native MCP transport'
        );
    });

    test('publishes a safe invocation and binds Docker credentials without reading them', async () => {
        const command = ['pi', '--mode', 'json'];
        const environment = {
            WORKBENCH_CREDENTIALS_DIR: '/workbench-credentials',
            SECRET: 'must-not-render',
        };
        const wrapped = piCredentialCommand(command, environment, '/workbench-config');

        expect(wrapped.slice(0, 3)).toEqual(['/bin/sh', '-c', expect.any(String)]);
        expect(wrapped.slice(-3)).toEqual(command);
        expect(environment).toMatchObject({
            PI_CODING_AGENT_DIR: '/tmp/workbench-pi',
            WORKBENCH_PI_CONFIG_DIR: '/workbench-config',
        });
        expect(
            publicPiInvocation({
                command: wrapped,
                cwd: '/workspace',
                env: environment,
            })
        ).toEqual({
            command: wrapped,
            cwd: '/workspace',
            pi_config_directory: '/tmp/workbench-pi',
        });
        expect(
            JSON.stringify(
                publicPiInvocation({
                    command: wrapped,
                    cwd: '/workspace',
                    env: environment,
                })
            )
        ).not.toContain('must-not-render');
    });

    test('rejects malformed native model routes and missing Docker configuration', async () => {
        const workbench = await fixture();
        expect(() =>
            buildPiInvocation(workbench, 'inspect', {}, '/workspace', 'invalid')
        ).toThrow('Pi model route must use provider/model');
        expect(() =>
            buildPiInvocation(
                workbench,
                'inspect',
                {},
                '/workspace',
                'openai/gpt-5.6-terra'
            )
        ).toThrow('Pi skills require a staged config directory');
        expect(() =>
            piCredentialCommand(['pi'], {
                WORKBENCH_CREDENTIALS_DIR: '/workbench-credentials',
            })
        ).toThrow('Pi Docker credentials require staged runner configuration');
    });
});

async function fixture(): Promise<ResolvedWorkbench> {
    const root = await mkdtemp(join(tmpdir(), 'pi-workbench-'));
    temporaryDirectories.push(root);
    const packageDirectory = join(root, '.workbenches', 'core');
    const skillDirectory = join(packageDirectory, 'skills', 'review');
    await mkdir(skillDirectory, { recursive: true });
    const instructionsPath = join(packageDirectory, 'instructions.md');
    await writeFile(instructionsPath, '# Workbench instructions\n');
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
            model: { id: 'openai/gpt-5.6-terra' },
            instructions: './instructions.md',
            skills: ['./skills/review'],
            tools: [],
            mcps: [],
            env: {},
            runtime: 'local',
        },
    };
}
