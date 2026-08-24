import { afterEach, describe, expect, test } from 'bun:test';
import {
    chmod,
    mkdir,
    mkdtemp,
    readdir,
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
        expect(result.stdout).toContain('update');
        expect(result.stdout).toContain('upgrade');
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
            model: 'openrouter/openai/gpt-5.6-terra',
            instructions: ['.workbenches/core/instructions.md'],
        });
        expect(result.stdout).toContain('● fixture-core');
        expect(result.stdout).toContain(
            'OpenCode · openrouter/openai/gpt-5.6-terra · local'
        );
        expect(result.stdout).toContain('fixture response');
        expect(result.stdout).toContain('✓ Completed');
    });

    test('binds declared environment from a file with repeatable explicit overrides', async () => {
        const fixture = await createFixture({
            env: {
                PROJECT_TOKEN: { required: true },
                OPTIONAL_TOKEN: { required: false },
            },
        });
        const bin = await fakeBin();
        const home = await temporaryDirectory('workbench-environment-home-');
        const record = join(fixture.root, 'runner');
        const environmentFile = join(fixture.root, '.env.workbench');
        const fileSecret = 'file-secret-not-for-output';
        const explicitSecret = 'explicit-secret-not-for-output';
        await writeFile(
            environmentFile,
            [
                `PROJECT_TOKEN=${fileSecret}`,
                'OPTIONAL_TOKEN=file-value',
                'UNDECLARED_TOKEN=ignored',
                '',
            ].join('\n')
        );

        const result = await executeCli(
            [
                'run',
                fixture.packageDirectory,
                '--task',
                'inspect',
                '--env-file',
                environmentFile,
                '--env',
                'OPTIONAL_TOKEN=first',
                '--env=OPTIONAL_TOKEN=explicit=value',
                '--env',
                `PROJECT_TOKEN=${explicitSecret}`,
            ],
            {
                PATH: `${bin}:${process.env.PATH}`,
                WB_TEST_RECORD: record,
                WORKBENCH_HOME: home,
                PROJECT_TOKEN: 'inherited-secret',
            }
        );

        expect(result.code).toBe(0);
        expect(await readFile(`${record}.project-token`, 'utf8')).toBe(
            `${explicitSecret}\n`
        );
        expect(await readFile(`${record}.optional-token`, 'utf8')).toBe(
            'explicit=value\n'
        );
        expect(await readFile(`${record}.undeclared-token`, 'utf8')).toBe('\n');
        expect(`${result.stdout}\n${result.stderr}`).not.toContain(fileSecret);
        expect(`${result.stdout}\n${result.stderr}`).not.toContain(explicitSecret);
        expect(await readTextTree(join(home, 'runs'))).not.toContain(explicitSecret);
    });

    test('binds declared sibling workspaces across smoke, run, and detached execution', async () => {
        const fixture = await createFixture({
            workspaces: {
                api: { required: true, access: 'read-write' },
                schemas: { required: false, access: 'read-only' },
            },
        });
        const api = await temporaryDirectory('workbench-api-workspace-');
        const schemas = await temporaryDirectory('workbench-schema-workspace-');
        const bin = await fakeBin([], { delay: true });
        const home = await temporaryDirectory('workbench-workspace-home-');
        const record = join(fixture.root, 'workspace-runner');
        const environment = {
            PATH: `${bin}:${process.env.PATH}`,
            WB_TEST_RECORD: record,
            WORKBENCH_HOME: home,
        };
        const bindings = [
            '--workspace',
            `api=${api}`,
            `--workspace=schemas=${schemas}`,
        ];

        const smoked = await executeCli(
            ['smoke', fixture.packageDirectory, ...bindings],
            environment
        );
        expect(smoked.code).toBe(0);

        const foreground = await executeCli(
            ['run', fixture.packageDirectory, '--task', 'inspect', ...bindings],
            environment
        );
        expect(foreground.code).toBe(0);
        expect(await readFile(`${record}.workspace-api`, 'utf8')).toBe(
            `${await realpath(api)}\n`
        );
        expect(await readFile(`${record}.workspace-schemas`, 'utf8')).toBe(
            `${await realpath(schemas)}\n`
        );

        const dispatched = await executeCli(
            [
                'run',
                fixture.packageDirectory,
                '--task',
                'inspect',
                '--detach',
                ...bindings,
            ],
            environment
        );
        expect(dispatched.code).toBe(0);
        expect(
            (
                await executeCli(
                    ['attach', dispatched.stdout.trim(), '--final'],
                    environment
                )
            ).code
        ).toBe(0);
        expect(await readFile(`${record}.workspace-api`, 'utf8')).toBe(
            `${await realpath(api)}\n`
        );

        const missing = await executeCli(
            ['smoke', fixture.packageDirectory],
            environment
        );
        expect(missing.code).toBe(1);
        expect(missing.stderr).toContain('Missing required workspace binding: api');
    });

    test('uses environment files during smoke and rejects undeclared explicit names', async () => {
        const fixture = await createFixture({
            env: { PROJECT_TOKEN: { required: true } },
        });
        const bin = await fakeBin();
        const environmentFile = join(fixture.root, '.env.workbench');
        await writeFile(environmentFile, 'PROJECT_TOKEN=available\n');

        const smoked = await executeCli(
            ['smoke', fixture.packageDirectory, '--env-file', environmentFile],
            { PATH: `${bin}:${process.env.PATH}` }
        );
        expect(smoked.code).toBe(0);
        expect(smoked.stdout).toContain('ready\tfixture-core');

        const rejected = await executeCli(
            [
                'run',
                fixture.packageDirectory,
                '--task',
                'inspect',
                '--env',
                'TYPO_TOKEN=do-not-echo-this',
            ],
            { PATH: `${bin}:${process.env.PATH}` }
        );
        expect(rejected.code).toBe(1);
        expect(rejected.stderr).toContain(
            'Environment override is not declared by fixture-core: TYPO_TOKEN'
        );
        expect(rejected.stderr).not.toContain('do-not-echo-this');
    });

    test('passes environment overrides to a detached worker without persisting values', async () => {
        const fixture = await createFixture({
            env: { PROJECT_TOKEN: { required: true } },
        });
        const bin = await fakeBin([], { delay: true });
        const home = await temporaryDirectory('workbench-environment-detached-');
        const record = join(fixture.root, 'detached-runner');
        const environmentFile = join(fixture.root, '.env.workbench');
        const secret = 'detached-secret-not-for-storage';
        await writeFile(environmentFile, `PROJECT_TOKEN=${secret}\n`);
        const environment = {
            PATH: `${bin}:${process.env.PATH}`,
            WB_TEST_RECORD: record,
            WORKBENCH_HOME: home,
        };

        const dispatched = await executeCli(
            [
                'run',
                fixture.packageDirectory,
                '--task',
                'inspect',
                '--detach',
                '--env-file',
                environmentFile,
            ],
            environment
        );
        expect(dispatched.code).toBe(0);

        const attached = await executeCli(
            ['attach', dispatched.stdout.trim(), '--json'],
            environment
        );
        expect(attached.code).toBe(0);
        expect(await readFile(`${record}.project-token`, 'utf8')).toBe(`${secret}\n`);
        expect(await readTextTree(join(home, 'runs'))).not.toContain(secret);
    });

    test('auto-colors human output when forced and honors --no-color', async () => {
        const fixture = await createFixture();
        const bin = await fakeBin();
        const environment = {
            PATH: `${bin}:${process.env.PATH}`,
            NO_COLOR: '1',
        };

        const colored = await executeCli(
            ['run', fixture.packageDirectory, '--task', 'inspect', '--color'],
            environment
        );
        expect(colored.code).toBe(0);
        expect(colored.stdout).toContain('\u001B[');

        const plain = await executeCli(
            ['run', fixture.packageDirectory, '--task', 'inspect', '--no-color'],
            environment
        );
        expect(plain.code).toBe(0);
        expect(plain.stdout).not.toContain('\u001B[');
    });

    test('renders runner Markdown in human mode without changing final output', async () => {
        const fixture = await createFixture();
        const response =
            '# Result\n\nThe **important** value is `safe`.\n\n- First\n- Second';
        const bin = await fakeBin([], { response });
        const environment = { PATH: `${bin}:${process.env.PATH}` };

        const human = await executeCli(
            ['run', fixture.packageDirectory, '--task', 'inspect', '--no-color'],
            environment
        );
        expect(human.code).toBe(0);
        expect(human.stdout).toContain(
            'Result\n\nThe important value is safe.\n\n• First\n• Second'
        );
        expect(human.stdout).not.toContain('**');
        expect(human.stdout).not.toContain('# Result');

        const final = await executeCli(
            ['run', fixture.packageDirectory, '--task', 'inspect', '--final'],
            environment
        );
        expect(final.code).toBe(0);
        expect(final.stdout).toBe(`${response}\n`);
    });

    test('supports positional tasks, normalized NDJSON, and final-only output', async () => {
        const fixture = await createFixture();
        const bin = await fakeBin();
        const environment = { PATH: `${bin}:${process.env.PATH}` };

        const json = await executeCli(
            ['run', fixture.packageDirectory, 'inspect', '--json'],
            environment
        );
        expect(json.code).toBe(0);
        const events = json.stdout
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line));
        expect(events.map((event) => event.type)).toEqual([
            'run.started',
            'run.ready',
            'turn.started',
            'output.text',
            'usage.updated',
            'turn.completed',
            'run.completed',
        ]);
        expect(events.every((event) => event.protocol === 0)).toBeTrue();

        const final = await executeCli(
            ['run', fixture.packageDirectory, '--task', 'inspect', '--final'],
            environment
        );
        expect(final.code).toBe(0);
        expect(final.stdout).toBe('fixture response\n');
    });

    test('reserves taskless and bare invocations for an interactive TUI', async () => {
        const fixture = await createFixture();
        const result = await executeCli(['run', fixture.packageDirectory]);

        expect(result.code).toBe(1);
        expect(result.stderr).toContain(
            'The Workbench TUI requires an interactive terminal'
        );

        const bare = await executeCli([]);
        expect(bare.code).toBe(1);
        expect(bare.stderr).toContain(
            'The Workbench TUI requires an interactive terminal'
        );
    });

    test('dispatches, prints only a run ID, and attaches to the latest run', async () => {
        const fixture = await createFixture();
        const home = await temporaryDirectory('workbench-detached-');
        const bin = await fakeBin([], { delay: true });
        const environment = {
            PATH: `${bin}:${process.env.PATH}`,
            WORKBENCH_HOME: home,
        };

        const dispatched = await executeCli(
            ['run', fixture.packageDirectory, '--task', 'inspect', '-d'],
            environment
        );
        expect(dispatched.code).toBe(0);
        expect(dispatched.stderr).toBe('');
        expect(dispatched.stdout.trim()).toMatch(/^wb_[a-z0-9]{20,64}$/);

        const attached = await executeCli(['attach', '--json'], environment);
        expect(attached.code).toBe(0);
        const events = attached.stdout
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line));
        expect(events[0]).toMatchObject({
            run_id: dispatched.stdout.trim(),
            type: 'run.started',
        });
        expect(events.at(-1)).toMatchObject({ type: 'run.completed' });

        const replayed = await executeCli(
            ['attach', dispatched.stdout.trim(), '--final'],
            environment
        );
        expect(replayed.code).toBe(0);
        expect(replayed.stdout).toBe('fixture response\n');
    });

    test('cancels the latest active detached run and records a terminal event', async () => {
        const fixture = await createFixture();
        const home = await temporaryDirectory('workbench-kill-');
        const bin = await fakeBin([], { block: true });
        const environment = {
            PATH: `${bin}:${process.env.PATH}`,
            WORKBENCH_HOME: home,
        };

        const dispatched = await executeCli(
            ['run', fixture.packageDirectory, '--task', 'wait', '-d'],
            environment
        );
        const id = dispatched.stdout.trim();
        expect(id).toMatch(/^wb_[a-z0-9]{20,64}$/);

        const killed = await executeCli(['kill'], environment);
        expect(killed.code).toBe(0);
        expect(killed.stdout).toBe(`cancelled\t${id}\n`);

        const attached = await executeCli(['attach', id, '--json'], environment);
        expect(attached.code).toBe(130);
        const events = attached.stdout
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line));
        expect(events.at(-1)).toMatchObject({
            run_id: id,
            type: 'run.cancelled',
            data: { reason: 'requested' },
        });

        const repeated = await executeCli(['kill', id], environment);
        expect(repeated.code).toBe(1);
        expect(repeated.stderr).toContain(`already cancelled: ${id}`);
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

    test('builds and reuses a Workbench-local Docker image', async () => {
        const fixture = await createFixture({ runtime: 'docker', localImage: true });
        const docker = await fakeDocker();
        const environment = {
            PATH: `${docker.bin}:${process.env.PATH}`,
            WB_DOCKER_RECORD: docker.record,
            WB_DOCKER_STATE: docker.state,
        };

        const built = await executeCli(
            ['build', fixture.packageDirectory, '--json'],
            environment
        );
        expect(built.code).toBe(0);
        expect(JSON.parse(built.stdout)).toMatchObject({
            kind: 'image',
            action: 'built',
        });

        const cached = await executeCli(
            ['build', fixture.packageDirectory, '--json'],
            environment
        );
        expect(cached.code).toBe(0);
        expect(JSON.parse(cached.stdout)).toMatchObject({
            kind: 'image',
            action: 'cache-hit',
        });

        const commands = await readFile(docker.record, 'utf8');
        expect(commands.match(/buildx build/g)).toHaveLength(1);
    });

    test('smokes required tools inside Docker before launching the runner', async () => {
        const fixture = await createFixture({
            runtime: 'docker',
            image: 'ghcr.io/example/lux:0.1.0',
            tools: ['cargo', 'lux'],
        });
        const docker = await fakeDocker();
        const result = await executeCli(['smoke', fixture.packageDirectory], {
            PATH: `${docker.bin}:${process.env.PATH}`,
            WB_DOCKER_RECORD: docker.record,
            WB_DOCKER_MISSING: 'lux',
        });

        expect(result.code).toBe(1);
        expect(result.stderr).toContain(
            'Required CLI tool is unavailable in Docker image'
        );
        expect(result.stderr).toContain(': lux');
        const commands = await readFile(docker.record, 'utf8');
        expect(commands).toContain('workbench-preflight cargo');
        expect(commands).toContain('workbench-preflight lux');
        expect(commands).not.toContain('--entrypoint opencode');
    });

    test('runs OpenCode in Docker with normalized output and named authorization', async () => {
        const fixture = await createFixture({
            runtime: 'docker',
            image: 'ghcr.io/example/lux:0.1.0',
            tools: ['lux'],
            env: { OPENROUTER_API_KEY: { required: true } },
        });
        const docker = await fakeDocker();
        const secret = 'do-not-place-this-value-in-docker-arguments';
        const result = await executeCli(
            ['run', fixture.packageDirectory, '--task', 'inspect', '--json'],
            {
                PATH: `${docker.bin}:${process.env.PATH}`,
                WB_DOCKER_RECORD: docker.record,
                OPENROUTER_API_KEY: secret,
            }
        );

        expect(result.code).toBe(0);
        const events = result.stdout
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line));
        expect(events.at(1)).toMatchObject({
            type: 'run.ready',
            data: { runner: 'opencode', tools: ['lux'] },
        });
        expect(events.at(-1)).toMatchObject({ type: 'run.completed' });

        const commands = await readFile(docker.record, 'utf8');
        expect(commands).toContain('--workdir /workspace');
        expect(commands).toContain('--entrypoint opencode');
        expect(commands).toContain('--env-file');
        expect(commands).not.toContain(secret);
    });

    test('requires an explicit grant before binding the host Docker engine', async () => {
        const fixture = await createFixture({
            runtime: 'docker',
            image: 'ghcr.io/example/lux:0.1.0',
            dockerEngine: true,
        });
        const docker = await fakeDocker();
        const socketDirectory = await temporaryDirectory('workbench-docker-socket-');
        const socketPath = join(socketDirectory, 'docker.sock');
        const home = await temporaryDirectory('workbench-docker-engine-home-');
        const server = Bun.listen({
            unix: socketPath,
            socket: { data() {} },
        });
        const environment = {
            PATH: `${docker.bin}:${process.env.PATH}`,
            WB_DOCKER_RECORD: docker.record,
            WB_DOCKER_SOCKET: socketPath,
            WORKBENCH_HOME: home,
        };
        try {
            const built = await executeCli(
                ['build', fixture.packageDirectory, '--json'],
                environment
            );
            expect(built.code).toBe(0);

            const denied = await executeCli(
                ['run', fixture.packageDirectory, '--task', 'inspect'],
                environment
            );
            expect(denied.code).toBe(1);
            expect(denied.stderr).toContain(
                'Host Docker engine access requires explicit --allow-host-docker authorization'
            );

            const allowed = await executeCli(
                [
                    'run',
                    fixture.packageDirectory,
                    '--task',
                    'inspect',
                    '--allow-host-docker',
                    '--json',
                ],
                environment
            );
            expect(allowed.code).toBe(0);
            const commands = await readFile(docker.record, 'utf8');
            expect(commands).toContain(`${socketPath}:/var/run/docker.sock`);
            expect(commands).toContain(`${fixture.root}:${fixture.root}`);
            expect(commands).toContain(`--workdir ${fixture.root}`);

            const detached = await executeCli(
                [
                    'run',
                    fixture.packageDirectory,
                    '--task',
                    'inspect',
                    '--allow-host-docker',
                    '--detach',
                ],
                environment
            );
            expect(detached.code).toBe(0);
            const attached = await executeCli(
                ['attach', detached.stdout.trim(), '--final'],
                environment
            );
            expect(attached.code).toBe(0);
        } finally {
            server.stop(true);
        }
    });

    test('dispatches and attaches to a detached Docker run', async () => {
        const fixture = await createFixture({
            runtime: 'docker',
            image: 'ghcr.io/example/lux:0.1.0',
            tools: ['lux'],
        });
        const docker = await fakeDocker();
        const home = await temporaryDirectory('workbench-docker-detached-');
        const environment = {
            PATH: `${docker.bin}:${process.env.PATH}`,
            WB_DOCKER_RECORD: docker.record,
            WORKBENCH_HOME: home,
        };

        const dispatched = await executeCli(
            ['run', fixture.packageDirectory, '--task', 'inspect', '--detach'],
            environment
        );
        expect(dispatched.code).toBe(0);
        const id = dispatched.stdout.trim();
        expect(id).toMatch(/^wb_[a-z0-9]{20,64}$/);

        const attached = await executeCli(['attach', id, '--json'], environment);
        expect(attached.code).toBe(0);
        const events = attached.stdout
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line));
        expect(events.at(-1)).toMatchObject({
            run_id: id,
            type: 'run.completed',
        });
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

        const saved = await executeCli(['list'], environment);
        expect(saved.stdout).toContain('fixture-saved\tfixture-core@0.1.0');

        const current = await executeCli(['upgrade'], environment);
        expect(current.code).toBe(0);
        expect(current.stdout).toContain('current\tfixture-saved\t0.1.0');

        await writeFile(
            join(fixture.packageDirectory, 'workbench.yml'),
            (
                await readFile(join(fixture.packageDirectory, 'workbench.yml'), 'utf8')
            ).replace('version: 0.1.0', 'version: 0.2.0')
        );
        await writeFile(
            join(fixture.packageDirectory, 'instructions.md'),
            '# upgraded fixture\n'
        );
        const upgraded = await executeCli(['upgrade', 'fixture-saved'], environment);
        expect(upgraded.code).toBe(0);
        expect(upgraded.stdout).toContain('upgraded\tfixture-saved\t0.1.0\t0.2.0');
        expect((await executeCli(['list'], environment)).stdout).toContain(
            'fixture-saved\tfixture-core@0.2.0'
        );

        const viewed = await executeCli(
            ['view', 'fixture-saved', '--json'],
            environment
        );
        expect(viewed.code).toBe(0);
        expect(JSON.parse(viewed.stdout)).toMatchObject({
            origin: {
                kind: 'saved',
                alias: 'fixture-saved',
                source: fixture.root,
                selector: 'core',
            },
            spec: 0,
            name: 'fixture-core',
            version: '0.2.0',
            runner: 'opencode',
            model: 'openrouter/openai/gpt-5.6-terra',
            runtime: 'local',
        });

        const humanView = await executeCli(['view', 'fixture-saved'], environment);
        expect(humanView.code).toBe(0);
        expect(humanView.stdout).toContain('fixture-core@0.2.0');
        expect(humanView.stdout).toContain('Origin       saved');

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
        expect((await executeCli(['list'], environment)).stdout).toBe('');
    });

    test('initializes .workbenches/name in the selected repository', async () => {
        const repository = await temporaryDirectory('workbench-init-');
        const result = await executeCli(['init', 'core'], {}, repository);
        expect(result.code).toBe(0);
        const manifest = await readFile(
            join(repository, '.workbenches/core/workbench.yml'),
            'utf8'
        );
        const instructions = await readFile(
            join(repository, '.workbenches/core/instructions.md'),
            'utf8'
        );
        expect(manifest).toContain('name: core');
        expect(manifest).toContain('runner: "opencode"');
        expect(manifest).toContain('model: "openrouter/openai/gpt-5.6-terra"');
        expect(manifest).toContain(
            'description: Repository-maintained expertise for core tasks.'
        );
        expect(instructions).toContain(
            "Use this repository's source, documentation, and tests"
        );

        const validated = await executeCli(['validate', repository], {}, repository);
        expect(validated.code).toBe(0);
        expect(validated.stdout).toContain('valid\tcore');

        const customized = await executeCli(
            ['init', 'review', '--runner', 'pi', '--model', 'example/custom-model'],
            {},
            repository
        );
        expect(customized.code).toBe(0);
        const customManifest = await readFile(
            join(repository, '.workbenches/review/workbench.yml'),
            'utf8'
        );
        expect(customManifest).toContain('runner: "pi"');
        expect(customManifest).toContain('model: "example/custom-model"');

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
    const home =
        environment.WORKBENCH_HOME ?? (await temporaryDirectory('workbench-cli-home-'));
    const child = Bun.spawn([process.execPath, cliPath, ...arguments_], {
        cwd,
        env: { ...process.env, ...environment, WORKBENCH_HOME: home },
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

async function readTextTree(directory: string): Promise<string> {
    const entries = await readdir(directory, { withFileTypes: true });
    const contents = await Promise.all(
        entries.map((entry) => {
            const path = join(directory, entry.name);
            return entry.isDirectory() ? readTextTree(path) : readFile(path, 'utf8');
        })
    );
    return contents.join('\n');
}

async function createFixture(
    options: {
        tools?: string[];
        skill?: boolean;
        runtime?: 'local' | 'docker';
        image?: string;
        localImage?: boolean;
        env?: Record<string, { required: boolean }>;
        workspaces?: Record<
            string,
            { required: boolean; access: 'read-only' | 'read-write' }
        >;
        dockerEngine?: boolean;
    } = {}
) {
    const root = await mkdtemp(join(tmpdir(), 'workbench-cli-'));
    temporaryDirectories.push(root);
    const packageDirectory = join(root, '.workbenches', 'core');
    await mkdir(packageDirectory, { recursive: true });
    await writeFile(join(packageDirectory, 'instructions.md'), '# Instructions\n');
    if (options.localImage) {
        await writeFile(
            join(packageDirectory, 'Dockerfile.workbench'),
            'FROM alpine:3.22\n'
        );
    }
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
            'model: openrouter/openai/gpt-5.6-terra',
            'instructions: ./instructions.md',
            ...(options.skill
                ? ['skills:', '  - ./skills/fixture-skill']
                : ['skills: []']),
            ...(options.tools?.length
                ? ['tools:', ...options.tools.map((tool) => `  - ${tool}`)]
                : ['tools: []']),
            'mcps: []',
            ...(options.env && Object.keys(options.env).length > 0
                ? [
                      'env:',
                      ...Object.entries(options.env).flatMap(([name, requirement]) => [
                          `  ${name}:`,
                          `    required: ${requirement.required}`,
                      ]),
                  ]
                : ['env: {}']),
            ...(options.workspaces && Object.keys(options.workspaces).length > 0
                ? [
                      'workspaces:',
                      ...Object.entries(options.workspaces).flatMap(
                          ([name, requirement]) => [
                              `  ${name}:`,
                              `    required: ${requirement.required}`,
                              `    access: ${requirement.access}`,
                          ]
                      ),
                  ]
                : []),
            `runtime: ${options.runtime ?? 'local'}`,
            ...(options.localImage
                ? ['image:', '  build: ./Dockerfile.workbench', '  context: .']
                : options.image
                  ? [`image: ${options.image}`]
                  : []),
            ...(options.dockerEngine ? ['docker:', '  engine:', '    mode: host'] : []),
            '',
        ].join('\n')
    );
    return { root, packageDirectory };
}

async function fakeDocker() {
    const bin = await temporaryDirectory('workbench-docker-bin-');
    const recordDirectory = await temporaryDirectory('workbench-docker-record-');
    const record = join(recordDirectory, 'commands');
    const state = join(recordDirectory, 'built');
    await writeFile(
        join(bin, 'docker'),
        [
            '#!/bin/sh',
            'printf "%s\\n" "$*" >> "$WB_DOCKER_RECORD"',
            'case "$1 $2" in',
            '  "version --format") printf "%s\\n" "28.1.1" ;;',
            '  "image pull") printf "%s\\n" "sha256:local" ;;',
            '  "image inspect")',
            '    case "$3" in',
            '      workbench-local/*)',
            '        test -f "$WB_DOCKER_STATE" || exit 1',
            '        printf "%s\\n" \'{"Id":"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","RepoDigests":[]}\'',
            '        ;;',
            '      *)',
            '        printf "%s\\n" \'{"Id":"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","RepoDigests":["ghcr.io/example/lux@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]}\'',
            '        ;;',
            '    esac',
            '    ;;',
            '  "context inspect") printf "%s\\n" "unix://$WB_DOCKER_SOCKET" ;;',
            '  "buildx build") : > "$WB_DOCKER_STATE" ;;',
            '  "container rm") exit 0 ;;',
            '  "run --rm")',
            '    last=""',
            '    entrypoint=""',
            '    previous=""',
            '    for argument in "$@"; do',
            '      test "$previous" = "--entrypoint" && entrypoint="$argument"',
            '      previous="$argument"',
            '      last="$argument"',
            '    done',
            '    if test "$entrypoint" = "/bin/sh"; then',
            '      test "$last" = "$WB_DOCKER_MISSING" && exit 127',
            '      case "$*" in',
            '        *"command -v"*) printf "/usr/local/bin/%s\\n" "$last" ;;',
            '      esac',
            '      exit 0',
            '    fi',
            '    if test "$entrypoint" = "opencode"; then',
            '      printf \'%s\\n\' \'{"type":"step_start","part":{"type":"step-start"}}\'',
            '      printf \'%s\\n\' \'{"type":"text","part":{"type":"text","text":"fixture response"}}\'',
            '      printf \'%s\\n\' \'{"type":"step_finish","part":{"type":"step-finish","reason":"stop","tokens":{"total":9,"input":4,"output":5,"reasoning":0,"cache":{"read":0,"write":0}},"cost":0.0001}}\'',
            '      exit 0',
            '    fi',
            '    if test "$entrypoint" = "docker"; then exit 0; fi',
            '    exit 1',
            '    ;;',
            '  *) exit 1 ;;',
            'esac',
            '',
        ].join('\n')
    );
    await chmod(join(bin, 'docker'), 0o755);
    return { bin, record, state };
}

async function fakeBin(
    tools: string[] = [],
    options: { delay?: boolean; block?: boolean; response?: string } = {}
) {
    const directory = await mkdtemp(join(tmpdir(), 'workbench-bin-'));
    temporaryDirectories.push(directory);
    const runner = join(directory, 'opencode');
    const responseEvent = JSON.stringify({
        type: 'text',
        part: { type: 'text', text: options.response ?? 'fixture response' },
    });
    await writeFile(
        runner,
        [
            '#!/bin/sh',
            ...(options.block ? ['exec sleep 30'] : []),
            'if test -n "$WB_TEST_RECORD"; then',
            '  printf "%s\\n" "$PWD" > "$WB_TEST_RECORD.cwd"',
            '  printf "%s\\n" "$@" > "$WB_TEST_RECORD.args"',
            '  printf "%s\\n" "$OPENCODE_CONFIG_CONTENT" > "$WB_TEST_RECORD.config"',
            '  printf "%s\\n" "$OPENCODE_CONFIG_DIR" > "$WB_TEST_RECORD.config-dir"',
            '  printf "%s\\n" "$PROJECT_TOKEN" > "$WB_TEST_RECORD.project-token"',
            '  printf "%s\\n" "$OPTIONAL_TOKEN" > "$WB_TEST_RECORD.optional-token"',
            '  printf "%s\\n" "$UNDECLARED_TOKEN" > "$WB_TEST_RECORD.undeclared-token"',
            '  printf "%s\\n" "$WORKBENCH_WORKSPACE_API" > "$WB_TEST_RECORD.workspace-api"',
            '  printf "%s\\n" "$WORKBENCH_WORKSPACE_SCHEMAS" > "$WB_TEST_RECORD.workspace-schemas"',
            'fi',
            ...(options.delay ? ['sleep 0.1'] : []),
            'printf \'%s\\n\' \'{"type":"step_start","part":{"type":"step-start"}}\'',
            `printf '%s\\n' '${responseEvent}'`,
            'printf \'%s\\n\' \'{"type":"step_finish","part":{"type":"step-finish","reason":"stop","tokens":{"total":9,"input":4,"output":5,"reasoning":0,"cache":{"read":0,"write":0}},"cost":0.0001}}\'',
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
