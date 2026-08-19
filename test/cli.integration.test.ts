import { afterEach, describe, expect, test } from 'bun:test';
import {
    chmod,
    mkdir,
    mkdtemp,
    readFile,
    realpath,
    rm,
    stat,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const projectDirectory = resolve(import.meta.dir, '..');
const cliPath = join(projectDirectory, 'src', 'cli.ts');
const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories
            .splice(0)
            .map((directory) => rm(directory, { recursive: true, force: true }))
    );
});

describe('CLI integration', () => {
    test('renders framework-generated command help', async () => {
        const result = await executeCli(['--help']);
        expect(result.code).toBe(0);
        expect(result.stdout).toContain(
            'Discover, save, verify, and run open Workbenches'
        );
        expect(result.stdout).toContain('run');
    });

    test('preflights declared tools before spawning the runner', async () => {
        const fixture = await createFixture({ tools: ['missing-workbench-tool'] });
        const record = join(fixture.root, 'runner-was-called');
        const bin = await fakeBin();
        const result = await executeCli(
            ['run', fixture.packageDirectory, '--task', 'do work'],
            { PATH: `${bin}:${process.env.PATH}` }
        );

        expect(result.code).toBe(1);
        expect(result.stderr).toContain(
            'Required CLI tool is unavailable: missing-workbench-tool'
        );
        await expect(stat(record)).rejects.toThrow();
    });

    test('runs the translated request through the selected local runner', async () => {
        const fixture = await createFixture({ tools: ['fixture-tool'] });
        const record = join(fixture.root, 'runner');
        const bin = await fakeBin(['fixture-tool']);
        const result = await executeCli(
            ['run', fixture.packageDirectory, '--task', '  inspect the project  '],
            {
                PATH: `${bin}:${process.env.PATH}`,
                WB_TEST_RECORD: record,
            }
        );

        expect(result.code).toBe(0);
        expect(await readFile(`${record}.cwd`, 'utf8')).toBe(`${fixture.root}\n`);
        expect(await readFile(`${record}.args`, 'utf8')).toContain(
            'inspect the project\n'
        );
        const config = JSON.parse(await readFile(`${record}.config`, 'utf8'));
        expect(config).toMatchObject({
            model: 'openrouter/openai/gpt-5.6-luna',
            instructions: ['.workbenches/core/instructions.md'],
        });
    });

    test('stages native skills for the child and cleans them after exit', async () => {
        const fixture = await createFixture({ skill: true });
        const record = join(fixture.root, 'runner');
        const bin = await fakeBin();
        const result = await executeCli(
            ['run', fixture.packageDirectory, '--task', 'use the fixture skill'],
            {
                PATH: `${bin}:${process.env.PATH}`,
                WB_TEST_RECORD: record,
            }
        );

        expect(result.code).toBe(0);
        const staged = (await readFile(`${record}.config-dir`, 'utf8')).trim();
        expect(staged).not.toBe('');
        await expect(stat(staged)).rejects.toThrow();
    });

    test('dry-run validates and translates without spawning the runner', async () => {
        const fixture = await createFixture();
        const record = join(fixture.root, 'runner-was-called');
        const bin = await fakeBin();
        const result = await executeCli(
            ['run', fixture.packageDirectory, '--task', 'inspect', '--dry-run'],
            {
                PATH: `${bin}:${process.env.PATH}`,
                WB_TEST_RECORD: record,
            }
        );

        expect(result.code).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
            cwd: fixture.root,
            skills: [],
        });
        await expect(stat(record)).rejects.toThrow();
    });

    test('lists, validates, smokes, saves, runs, and removes a Workbench', async () => {
        const fixture = await createFixture({ tools: ['fixture-tool'] });
        const home = await temporaryDirectory('workbench-home-');
        const workspace = await temporaryDirectory('workbench-target-');
        const bin = await fakeBin(['fixture-tool']);
        const environment = {
            PATH: `${bin}:${process.env.PATH}`,
            WORKBENCH_HOME: home,
        };

        const listed = await executeCli(['list', fixture.root], environment);
        expect(listed.code).toBe(0);
        expect(listed.stdout).toContain('core\tfixture-core@0.1.0');

        const validated = await executeCli(['validate', fixture.root], environment);
        expect(validated.code).toBe(0);
        expect(validated.stdout).toContain('valid\tfixture-core@0.1.0');

        const smoked = await executeCli(['smoke', fixture.root], environment);
        expect(smoked.code).toBe(0);
        expect(smoked.stdout).toContain('ready\tfixture-core');
        expect(smoked.stdout).toContain('fixture-tool');

        const added = await executeCli(
            ['add', `${fixture.root}#core`, '--as', 'fixture-saved'],
            environment
        );
        expect(added.code).toBe(0);
        expect(added.stdout).toContain('saved\tfixture-saved\tsha256:');

        const saved = await executeCli(['list', '--saved'], environment);
        expect(saved.stdout).toContain('fixture-saved\tfixture-core@0.1.0');

        const translated = await executeCli(
            ['run', 'fixture-saved', '--task', 'inspect', '--dry-run'],
            environment,
            workspace
        );
        expect(translated.code).toBe(0);
        const invocation = JSON.parse(translated.stdout);
        expect(invocation.cwd).toBe(await realpath(workspace));
        expect(invocation.opencode_config.instructions[0]).toContain(home);

        const removed = await executeCli(['remove', 'fixture-saved'], environment);
        expect(removed.code).toBe(0);
        expect(removed.stdout).toContain('removed\tfixture-saved');
        expect((await executeCli(['list', '--saved'], environment)).stdout).toBe('');
    });

    test('initializes .workbenches/name in the selected repository', async () => {
        const repository = await temporaryDirectory('workbench-init-');
        const result = await executeCli(['init', 'core'], {}, repository);
        expect(result.code).toBe(0);
        expect(
            await readFile(join(repository, '.workbenches/core/workbench.yml'), 'utf8')
        ).toContain('name: core');

        const duplicate = await executeCli(['init', 'core'], {}, repository);
        expect(duplicate.code).toBe(1);
        expect(duplicate.stderr).toContain('Workbench already exists');
    });

    test('refuses to materialize a remote Workbench for a direct run', async () => {
        const result = await executeCli([
            'run',
            'lux-db/lux#migrations',
            '--task',
            'inspect',
        ]);
        expect(result.code).toBe(1);
        expect(result.stderr).toContain(
            'Remote Workbenches must be saved before running'
        );
        expect(result.stderr).toContain('wb add lux-db/lux#migrations');
        expect(result.stderr).not.toContain('at async');
        expect(result.stderr).not.toContain('/$bunfs/');
    });
});

async function executeCli(
    arguments_: string[],
    environment: Record<string, string | undefined> = {},
    cwd = projectDirectory
) {
    const child = Bun.spawn([process.execPath, cliPath, ...arguments_], {
        cwd,
        env: { ...process.env, ...environment },
        stdout: 'pipe',
        stderr: 'pipe',
    });
    const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
    ]);
    return { stdout, stderr, code };
}

async function temporaryDirectory(prefix: string) {
    const directory = await mkdtemp(join(tmpdir(), prefix));
    temporaryDirectories.push(directory);
    return directory;
}

async function createFixture(options: { tools?: string[]; skill?: boolean } = {}) {
    const root = await mkdtemp(join(tmpdir(), 'workbench-cli-'));
    temporaryDirectories.push(root);
    const packageDirectory = join(root, '.workbenches', 'core');
    await mkdir(packageDirectory, { recursive: true });
    await writeFile(join(packageDirectory, 'instructions.md'), '# Instructions\n');
    if (options.skill) {
        const skillDirectory = join(packageDirectory, 'skills', 'fixture-skill');
        await mkdir(skillDirectory, { recursive: true });
        await writeFile(
            join(skillDirectory, 'SKILL.md'),
            '---\nname: fixture-skill\ndescription: Exercise staging.\n---\n'
        );
    }
    await writeFile(
        join(packageDirectory, 'workbench.yml'),
        [
            'spec: 0',
            'version: 0.1.0',
            'name: fixture-core',
            'runner: opencode',
            'model: openrouter/openai/gpt-5.6-luna',
            'instructions: ./instructions.md',
            ...(options.skill
                ? ['skills:', '  - ./skills/fixture-skill']
                : ['skills: []']),
            ...(options.tools?.length
                ? ['tools:', ...options.tools.map((tool) => `  - ${tool}`)]
                : ['tools: []']),
            'mcps: []',
            'env: {}',
            'runtime: local',
            '',
        ].join('\n')
    );
    return { root, packageDirectory };
}

async function fakeBin(tools: string[] = []) {
    const directory = await mkdtemp(join(tmpdir(), 'workbench-bin-'));
    temporaryDirectories.push(directory);
    const runner = join(directory, 'opencode');
    await writeFile(
        runner,
        [
            '#!/bin/sh',
            'test -n "$WB_TEST_RECORD" || exit 0',
            'printf "%s\\n" "$PWD" > "$WB_TEST_RECORD.cwd"',
            'printf "%s\\n" "$@" > "$WB_TEST_RECORD.args"',
            'printf "%s\\n" "$OPENCODE_CONFIG_CONTENT" > "$WB_TEST_RECORD.config"',
            'printf "%s\\n" "$OPENCODE_CONFIG_DIR" > "$WB_TEST_RECORD.config-dir"',
            '',
        ].join('\n')
    );
    await chmod(runner, 0o755);
    for (const tool of tools) {
        const path = join(directory, tool);
        await writeFile(path, '#!/bin/sh\nexit 0\n');
        await chmod(path, 0o755);
    }
    return directory;
}
