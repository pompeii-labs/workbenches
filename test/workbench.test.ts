import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { resolveWorkbench } from '../src/manifest.js';
import {
    buildOpenCodeInvocation,
    publicInvocation,
} from '../src/opencode.js';
import { stageOpenCodeSkills } from '../src/run.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories.splice(0).map((directory) =>
            rm(directory, { recursive: true, force: true })
        )
    );
});

describe('Workbench v0', () => {
    test('translates instructions to OpenCode config and keeps the task separate', async () => {
        const fixture = await createFixture();
        const workbench = await resolveWorkbench(fixture.workbenchDirectory);
        const invocation = buildOpenCodeInvocation(
            workbench,
            'Implement XRANGE support',
            { PATH: process.env.PATH }
        );
        const visible = publicInvocation(invocation);

        expect(visible.cwd).toBe(fixture.repositoryDirectory);
        expect(visible.opencode_config).toMatchObject({
            model: 'openrouter/openai/gpt-5.6-luna',
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
        const workbench = await resolveWorkbench(fixture.workbenchDirectory);
        expect(() => buildOpenCodeInvocation(workbench, 'Do work')).toThrow(
            'Unsupported runner: codex'
        );
    });

    test('rejects required environment that the host did not bind', async () => {
        const fixture = await createFixture({
            env: '  REQUIRED_TOKEN:\n    required: true\n',
        });
        const workbench = await resolveWorkbench(fixture.workbenchDirectory);
        expect(() => buildOpenCodeInvocation(workbench, 'Do work', {})).toThrow(
            'Missing required environment variable: REQUIRED_TOKEN'
        );
    });

    test('rejects instruction paths outside the repository', async () => {
        const fixture = await createFixture({ instructions: '../../../outside.md' });
        await expect(resolveWorkbench(fixture.workbenchDirectory)).rejects.toThrow(
            'instructions must remain inside the repository'
        );
    });

    test('stages package skills for native OpenCode discovery', async () => {
        const fixture = await createFixture({ skill: true });
        const workbench = await resolveWorkbench(fixture.workbenchDirectory);
        const staged = await stageOpenCodeSkills(workbench);

        expect(staged).toBeDefined();
        expect(
            await stat(join(staged!.directory, 'skills', 'lux-migrations', 'SKILL.md'))
        ).toBeTruthy();
        const invocation = buildOpenCodeInvocation(
            workbench,
            'Plan a migration',
            { PATH: process.env.PATH },
            staged!.directory
        );
        expect(invocation.env.OPENCODE_CONFIG_DIR).toBe(staged!.directory);

        await staged!.cleanup();
        await expect(stat(staged!.directory)).rejects.toThrow();
    });

    test('enables an MCP only when its optional environment is bound', async () => {
        const fixture = await createFixture({ mcp: true });
        const workbench = await resolveWorkbench(fixture.workbenchDirectory);

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
}

async function createFixture(options: FixtureOptions = {}) {
    const repositoryDirectory = await mkdtemp(join(tmpdir(), 'workbench-'));
    temporaryDirectories.push(repositoryDirectory);
    const workbenchDirectory = join(
        repositoryDirectory,
        '.workbenches',
        'maintainer'
    );
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
    await writeFile(
        manifestPath,
        [
            'version: 0',
            'name: fixture',
            `runner: ${options.runner ?? 'opencode'}`,
            'model: openrouter/openai/gpt-5.6-luna',
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
                      '      Authorization: Bearer ${LUX_TOKEN}',
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
