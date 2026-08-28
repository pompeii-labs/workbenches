import { afterEach, describe, expect, test } from 'bun:test';
import {
    mkdir,
    mkdtemp,
    readFile,
    rm,
    stat,
    symlink,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stageOpenCodeSkills } from '../src/runners/opencode/assets.js';
import {
    buildOpenCodeInvocation,
    publicInvocation,
} from '../src/runners/opencode/invocation.js';
import { Workbench } from '../src/workbench/index.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories
            .splice(0)
            .map((directory) => rm(directory, { recursive: true, force: true }))
    );
});

describe('Workbench package', () => {
    test('translates instructions to OpenCode config and keeps the task separate', async () => {
        const fixture = await createFixture();
        const workbench = await Workbench.load(fixture.workbenchDirectory);
        const invocation = buildOpenCodeInvocation(
            workbench,
            'Implement XRANGE support',
            { PATH: process.env.PATH }
        );
        const visible = publicInvocation(invocation);

        expect(visible.cwd).toBe(fixture.repositoryDirectory);
        expect(visible.opencode_config).toMatchObject({
            model: 'openai/gpt-5.6-terra',
            instructions: ['.workbenches/maintainer/instructions.md'],
        });
        expect(JSON.stringify(visible.opencode_config)).not.toContain(
            'Implement XRANGE support'
        );
        expect(visible.command.at(-1)).toBe('Implement XRANGE support');
        expect(visible.command).not.toContain(fixture.manifestPath);
        expect(visible.command).toContain('--dir');
        expect(visible.command).toContain(fixture.repositoryDirectory);
        expect(invocation.env.PWD).toBe(fixture.repositoryDirectory);
    });

    test('rejects a runner that the reference engine does not implement', async () => {
        const fixture = await createFixture({ runner: 'codex' });
        const workbench = await Workbench.load(fixture.workbenchDirectory);
        expect(() => buildOpenCodeInvocation(workbench, 'Do work')).toThrow(
            'Unsupported runner: codex'
        );
    });

    test('rejects required environment that the host did not bind', async () => {
        const fixture = await createFixture({
            env: '  REQUIRED_TOKEN:\n    required: true\n',
        });
        const workbench = await Workbench.load(fixture.workbenchDirectory);
        expect(() => buildOpenCodeInvocation(workbench, 'Do work', {})).toThrow(
            'Missing required environment variable: REQUIRED_TOKEN'
        );
    });

    test('rejects instruction paths outside the repository', async () => {
        const fixture = await createFixture({
            instructions: '../../../outside.md',
        });
        await expect(Workbench.load(fixture.workbenchDirectory)).rejects.toThrow(
            'instructions must remain inside the repository'
        );
    });

    test('stages package skills for native OpenCode discovery', async () => {
        const fixture = await createFixture({ skill: true });
        const workbench = await Workbench.load(fixture.workbenchDirectory);
        const staged = await stageOpenCodeSkills(workbench);

        expect(staged).toBeDefined();
        if (!staged) throw new Error('expected staged skills');
        expect(
            await stat(join(staged.directory, 'skills', 'lux-migrations', 'SKILL.md'))
        ).toBeTruthy();
        const invocation = buildOpenCodeInvocation(
            workbench,
            'Plan a migration',
            { PATH: process.env.PATH },
            staged.directory
        );
        expect(invocation.env.OPENCODE_CONFIG_DIR).toBe(staged.directory);

        await staged.cleanup();
        await expect(stat(staged.directory)).rejects.toThrow();
    });

    test('stages packaged OpenCode configuration with Workbench skills', async () => {
        const fixture = await createFixture({ skill: true, runnerConfig: true });
        const workbench = await Workbench.load(fixture.workbenchDirectory);
        const staged = await stageOpenCodeSkills(workbench);
        expect(staged).toBeDefined();
        if (!staged) throw new Error('expected staged OpenCode config');

        expect(await readFile(join(staged.directory, 'opencode.json'), 'utf8')).toBe(
            '{"provider":{"local":{"npm":"@ai-sdk/openai-compatible"}}}\n'
        );
        expect(
            await readFile(join(staged.directory, 'plugins', 'native.ts'), 'utf8')
        ).toBe('export default {}\n');
        expect(
            await readFile(
                join(staged.directory, 'skills', 'lux-migrations', 'SKILL.md'),
                'utf8'
            )
        ).toContain('# Lux migrations');

        await staged.cleanup();
    });

    test('rejects credentials and symbolic links in packaged runner configuration', async () => {
        const credentialFile = await createFixture({ runnerConfig: true });
        await writeFile(
            join(credentialFile.workbenchDirectory, 'runner', 'auth.json'),
            '{"token":"secret"}\n'
        );
        await expect(Workbench.load(credentialFile.workbenchDirectory)).rejects.toThrow(
            'runner_config contains a credential file: auth.json'
        );

        const literal = await createFixture({ runnerConfig: true });
        await writeFile(
            join(literal.workbenchDirectory, 'runner', 'opencode.json'),
            '{"provider":{"private":{"apiKey":"literal-secret"}}}\n'
        );
        await expect(Workbench.load(literal.workbenchDirectory)).rejects.toThrow(
            'runner_config must reference credentials by environment name'
        );

        const authorization = await createFixture({ runnerConfig: true });
        await writeFile(
            join(authorization.workbenchDirectory, 'runner', 'opencode.json'),
            '{"provider":{"private":{"authorization":"Bearer literal-secret"}}}\n'
        );
        await expect(Workbench.load(authorization.workbenchDirectory)).rejects.toThrow(
            'runner_config must reference credentials by environment name'
        );

        const environmentReference = await createFixture({ runnerConfig: true });
        await writeFile(
            join(environmentReference.workbenchDirectory, 'runner', 'opencode.json'),
            '{"provider":{"private":{"authorization":"Bearer {env:PRIVATE_TOKEN}"}}}\n'
        );
        await expect(
            Workbench.load(environmentReference.workbenchDirectory)
        ).resolves.toBeDefined();

        const privateKey = await createFixture({ runnerConfig: true });
        await writeFile(
            join(privateKey.workbenchDirectory, 'runner', 'identity.pem'),
            'credential material\n'
        );
        await expect(Workbench.load(privateKey.workbenchDirectory)).rejects.toThrow(
            'runner_config contains a credential file: identity.pem'
        );

        const linked = await createFixture({ runnerConfig: true });
        await symlink(
            linked.instructionsPath,
            join(linked.workbenchDirectory, 'runner', 'linked.json')
        );
        await expect(Workbench.load(linked.workbenchDirectory)).rejects.toThrow(
            'runner_config must not contain symbolic links'
        );
    });

    test('requires Pi runner configuration to be a directory', async () => {
        const fixture = await createFixture({ runner: 'pi', runnerConfig: true });
        await rm(join(fixture.workbenchDirectory, 'runner'), {
            recursive: true,
            force: true,
        });
        await writeFile(join(fixture.workbenchDirectory, 'runner'), '{}\n');

        await expect(Workbench.load(fixture.workbenchDirectory)).rejects.toThrow(
            'Pi runner_config must be a directory'
        );
    });

    test('enables an MCP only when its optional environment is bound', async () => {
        const fixture = await createFixture({ mcp: true });
        const workbench = await Workbench.load(fixture.workbenchDirectory);

        const absent = publicInvocation(
            buildOpenCodeInvocation(workbench, 'Inspect Lux', {
                PATH: process.env.PATH,
            })
        );
        expect(absent.opencode_config).not.toHaveProperty('mcp');

        const present = publicInvocation(
            buildOpenCodeInvocation(workbench, 'Inspect Lux', {
                PATH: process.env.PATH,
                LUX_TOKEN: 'test-secret',
            })
        );
        expect(present.opencode_config).toMatchObject({
            mcp: {
                lux: {
                    type: 'remote',
                    url: 'https://api.luxdb.dev/mcp',
                    headers: { Authorization: 'Bearer {env:LUX_TOKEN}' },
                },
            },
        });
        expect(JSON.stringify(present)).not.toContain('test-secret');
    });
});

interface FixtureOptions {
    runner?: string;
    instructions?: string;
    env?: string;
    skill?: boolean;
    mcp?: boolean;
    runnerConfig?: boolean;
}

async function createFixture(options: FixtureOptions = {}) {
    const repositoryDirectory = await mkdtemp(join(tmpdir(), 'workbench-'));
    temporaryDirectories.push(repositoryDirectory);
    const workbenchDirectory = join(repositoryDirectory, '.workbenches', 'maintainer');
    await mkdir(workbenchDirectory, { recursive: true });
    const instructionsPath = join(workbenchDirectory, 'instructions.md');
    const manifestPath = join(workbenchDirectory, 'workbench.yml');
    await writeFile(instructionsPath, '# Maintain this project\n');
    if (options.skill) {
        const skillDirectory = join(workbenchDirectory, 'skills', 'lux-migrations');
        await mkdir(skillDirectory, { recursive: true });
        await writeFile(
            join(skillDirectory, 'SKILL.md'),
            [
                '---',
                'name: lux-migrations',
                'description: Plan and verify Lux database migrations.',
                '---',
                '',
                '# Lux migrations',
                '',
            ].join('\n')
        );
    }
    if (options.runnerConfig) {
        await mkdir(join(workbenchDirectory, 'runner', 'plugins'), {
            recursive: true,
        });
        await writeFile(
            join(workbenchDirectory, 'runner', 'opencode.json'),
            '{"provider":{"local":{"npm":"@ai-sdk/openai-compatible"}}}\n'
        );
        await writeFile(
            join(workbenchDirectory, 'runner', 'plugins', 'native.ts'),
            'export default {}\n'
        );
    }
    await writeFile(
        manifestPath,
        [
            'spec: 0',
            'version: 0.1.0',
            'name: fixture',
            `runner: ${options.runner ?? 'opencode'}`,
            'model:',
            '  id: openai/gpt-5.6-terra',
            ...(options.runnerConfig ? ['runner_config: ./runner'] : []),
            `instructions: ${options.instructions ?? './instructions.md'}`,
            ...(options.skill
                ? ['skills:', '  - ./skills/lux-migrations']
                : ['skills: []']),
            'tools: []',
            ...(options.mcp
                ? [
                      'mcps:',
                      '  - name: lux',
                      '    transport: http',
                      '    url: https://api.luxdb.dev/mcp',
                      '    headers:',
                      '      Authorization: Bearer $' + '{LUX_TOKEN}',
                  ]
                : ['mcps: []']),
            options.env || options.mcp ? 'env:' : 'env: {}',
            ...(options.env
                ? [options.env]
                : options.mcp
                  ? ['  LUX_TOKEN:', '    required: false']
                  : []),
            'runtime: local',
            '',
        ].join('\n')
    );
    return {
        repositoryDirectory,
        workbenchDirectory,
        instructionsPath,
        manifestPath,
    };
}
