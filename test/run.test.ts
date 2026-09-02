import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type WorkbenchEvent, WorkbenchRun } from '../src/runs/index.js';
import { type RuntimeAsset, RuntimeRegistry } from '../src/runtimes/index.js';

const temporaryDirectories: string[] = [];
const TEST_ENVIRONMENT = {
    PATH: '/fixture/bin',
    OPENROUTER_API_KEY: 'fixture-openrouter-key',
};

afterEach(async () => {
    await Promise.all(
        temporaryDirectories
            .splice(0)
            .map((directory) => rm(directory, { recursive: true, force: true }))
    );
});

describe('local run lifecycle', () => {
    test('fails runner preflight before checking tools or spawning', async () => {
        const fixture = await createFixture({ tools: ['cargo'] });
        const checked: string[] = [];
        let spawned = false;
        const events: WorkbenchEvent[] = [];

        const code = await WorkbenchRun.execute(
            {
                workbenchPath: fixture.packageDirectory,
                task: 'task',
                onEvent: (event) => {
                    events.push(event);
                },
            },
            {
                env: TEST_ENVIRONMENT,
                findExecutable(name) {
                    checked.push(name);
                    return null;
                },
                spawn() {
                    spawned = true;
                    return { exited: Promise.resolve(0) };
                },
            }
        );
        expect(code).toBe(1);
        expect(events.at(-1)).toMatchObject({
            type: 'run.failed',
            data: { message: 'Runner CLI is unavailable: opencode' },
        });
        expect(checked).toEqual(['opencode']);
        expect(spawned).toBeFalse();
    });

    test('fails declared-tool preflight before spawning', async () => {
        const fixture = await createFixture({ tools: ['cargo', 'lux'] });
        const checked: string[] = [];
        let spawned = false;
        const events: WorkbenchEvent[] = [];

        const code = await WorkbenchRun.execute(
            {
                workbenchPath: fixture.packageDirectory,
                task: 'task',
                onEvent: (event) => {
                    events.push(event);
                },
            },
            {
                env: TEST_ENVIRONMENT,
                findExecutable(name) {
                    checked.push(name);
                    return name === 'lux' ? null : `/bin/${name}`;
                },
                spawn() {
                    spawned = true;
                    return { exited: Promise.resolve(0) };
                },
            }
        );
        expect(code).toBe(1);
        expect(events.at(-1)).toMatchObject({
            type: 'run.failed',
            data: { message: 'Required CLI tool is unavailable: lux' },
        });
        expect(checked).toEqual(['opencode', 'cargo', 'lux']);
        expect(spawned).toBeFalse();
    });

    test('dry-run prints translation without invoking the runner', async () => {
        const fixture = await createFixture();
        let output = '';
        let spawned = false;

        const code = await WorkbenchRun.execute(
            {
                workbenchPath: fixture.packageDirectory,
                task: 'inspect',
                dryRun: true,
            },
            {
                env: TEST_ENVIRONMENT,
                findExecutable: () => '/bin/opencode',
                write(value) {
                    output += value;
                },
                spawn() {
                    spawned = true;
                    return { exited: Promise.resolve(0) };
                },
            }
        );

        expect(code).toBe(0);
        expect(spawned).toBeFalse();
        expect(JSON.parse(output)).toMatchObject({
            cwd: fixture.root,
            skills: [],
            model_route: {
                catalog_version: expect.any(String),
            },
        });
    });

    test('passes the translated command and environment to the runner', async () => {
        const fixture = await createFixture();
        let command: string[] = [];
        let cwd = '';
        let config = '';
        let launches = 0;
        let launchCompleted = false;

        const code = await WorkbenchRun.execute(
            {
                workbenchPath: fixture.packageDirectory,
                task: 'inspect',
                async onLaunch() {
                    launches += 1;
                    await Promise.resolve();
                    launchCompleted = true;
                },
            },
            {
                env: TEST_ENVIRONMENT,
                findExecutable: () => '/fixture/bin/opencode',
                spawn(nextCommand, options) {
                    command = nextCommand;
                    cwd = options.cwd;
                    config = options.env.OPENCODE_CONFIG_CONTENT ?? '';
                    return { exited: Promise.resolve(7) };
                },
            }
        );

        expect(code).toBe(7);
        expect(command[0]).toBe('opencode');
        expect(command.at(-1)).toBe('inspect');
        expect(cwd).toBe(fixture.root);
        expect(JSON.parse(config)).toMatchObject({
            instructions: ['.workbenches/core/instructions.md'],
        });
        expect(launches).toBe(1);
        expect(launchCompleted).toBeTrue();
    });

    test('runs a Pi Workbench through the same lifecycle and normalized protocol', async () => {
        const fixture = await createFixture({ runner: 'pi' });
        const events: WorkbenchEvent[] = [];
        let command: string[] = [];
        const stdout = [
            { type: 'session', version: 3, id: 'pi_run' },
            { type: 'agent_start' },
            { type: 'turn_start' },
            {
                type: 'message_update',
                assistantMessageEvent: {
                    type: 'thinking_delta',
                    delta: 'MUST_NOT_RENDER_REASONING',
                },
            },
            {
                type: 'message_update',
                assistantMessageEvent: { type: 'text_delta', delta: 'Pi works' },
            },
            { type: 'turn_end', message: { stopReason: 'stop' } },
            { type: 'agent_end', messages: [] },
        ]
            .map((event) => JSON.stringify(event))
            .join('\n');

        const code = await WorkbenchRun.execute(
            {
                workbenchPath: fixture.packageDirectory,
                task: 'inspect',
                onEvent: (event) => void events.push(event),
            },
            {
                env: TEST_ENVIRONMENT,
                findExecutable: () => '/bin/pi',
                spawn(nextCommand) {
                    if (nextCommand.includes('--list-models')) {
                        return {
                            exited: Promise.resolve(0),
                            stdout: new Response('').body as ReadableStream<Uint8Array>,
                            stderr: new Response(
                                'provider  model\nopenrouter  openai/gpt-5.6-terra\n'
                            ).body as ReadableStream<Uint8Array>,
                        };
                    }
                    command = nextCommand;
                    return {
                        exited: Promise.resolve(0),
                        stdout: new Response(`${stdout}\n`)
                            .body as ReadableStream<Uint8Array>,
                        stderr: new Response('').body as ReadableStream<Uint8Array>,
                    };
                },
            }
        );

        expect(code).toBe(0);
        expect(command.slice(0, 3)).toEqual(['pi', '--mode', 'json']);
        expect(command.at(-1)).toBe('inspect');
        expect(events[0]).toMatchObject({
            type: 'run.started',
            data: {
                model_route: {
                    catalog_version: expect.any(String),
                },
            },
        });
        expect(events).toContainEqual(
            expect.objectContaining({
                type: 'output.text',
                runner: 'pi',
                data: expect.objectContaining({ text: 'Pi works' }),
            })
        );
        expect(JSON.stringify(events)).not.toContain('MUST_NOT_RENDER_REASONING');
        expect(events.at(-1)).toMatchObject({ type: 'run.completed' });
    });

    test('reports the safe error carried by a failed OpenCode event', async () => {
        const fixture = await createFixture();
        const events: WorkbenchEvent[] = [];
        const stdout = `${JSON.stringify({
            type: 'error',
            error: {
                data: {
                    message: 'Missing Authentication header',
                    statusCode: 401,
                    responseBody: 'SECRET_RESPONSE_BODY',
                },
            },
        })}\n`;

        const code = await WorkbenchRun.execute(
            {
                workbenchPath: fixture.packageDirectory,
                task: 'inspect',
                onEvent(event) {
                    events.push(event);
                },
            },
            {
                env: TEST_ENVIRONMENT,
                findExecutable: () => '/bin/opencode',
                spawn() {
                    return {
                        exited: Promise.resolve(1),
                        stdout: new Response(stdout).body as ReadableStream<Uint8Array>,
                        stderr: new Response('').body as ReadableStream<Uint8Array>,
                    };
                },
            }
        );

        expect(code).toBe(1);
        expect(events.at(-1)).toMatchObject({
            type: 'run.failed',
            data: {
                message:
                    'OpenCode exited with code 1: HTTP 401: Missing Authentication header',
            },
        });
        expect(JSON.stringify(events)).not.toContain('SECRET_RESPONSE_BODY');
    });

    test('removes terminal control sequences from runner diagnostics', async () => {
        const fixture = await createFixture();
        const events: WorkbenchEvent[] = [];

        const code = await WorkbenchRun.execute(
            {
                workbenchPath: fixture.packageDirectory,
                task: 'inspect',
                onEvent(event) {
                    events.push(event);
                },
            },
            {
                env: TEST_ENVIRONMENT,
                findExecutable: () => '/bin/opencode',
                spawn() {
                    return {
                        exited: Promise.resolve(1),
                        stdout: new Response('').body as ReadableStream<Uint8Array>,
                        stderr: new Response(
                            '\u001b[91m\u001b[1mError: \u001b[0mUnexpected error\n'
                        ).body as ReadableStream<Uint8Array>,
                    };
                },
            }
        );

        expect(code).toBe(1);
        expect(events.at(-1)).toMatchObject({
            type: 'run.failed',
            data: { message: 'OpenCode exited with code 1: Error: Unexpected error' },
        });
    });

    test('redacts declared Workbench environment values from failures', async () => {
        const fixture = await createFixture({ env: ['OPENAI_API_KEY'] });
        const events: WorkbenchEvent[] = [];
        const targetSecret = 'mapped-target-secret';

        const code = await WorkbenchRun.execute(
            {
                workbenchPath: fixture.packageDirectory,
                task: 'inspect',
                onEvent(event) {
                    events.push(event);
                },
            },
            {
                env: {
                    ...TEST_ENVIRONMENT,
                    OPENAI_API_KEY: targetSecret,
                },
                findExecutable: () => '/bin/opencode',
                spawn() {
                    return {
                        exited: Promise.resolve(1),
                        stdout: new Response('').body as ReadableStream<Uint8Array>,
                        stderr: new Response(`credential ${targetSecret}\n`)
                            .body as ReadableStream<Uint8Array>,
                    };
                },
            }
        );

        expect(code).toBe(1);
        expect(JSON.stringify(events)).not.toContain(targetSecret);
        expect(events.at(-1)).toMatchObject({
            type: 'run.failed',
            data: {
                message: 'OpenCode exited with code 1: credential [REDACTED]',
            },
        });
    });

    test('redacts model provider credentials that are not declared as Workbench env', async () => {
        const fixture = await createFixture();
        const events: WorkbenchEvent[] = [];
        const targetSecret = TEST_ENVIRONMENT.OPENROUTER_API_KEY;

        const code = await WorkbenchRun.execute(
            {
                workbenchPath: fixture.packageDirectory,
                task: 'inspect',
                onEvent(event) {
                    events.push(event);
                },
            },
            {
                env: TEST_ENVIRONMENT,
                findExecutable: () => '/bin/opencode',
                spawn() {
                    return {
                        exited: Promise.resolve(1),
                        stdout: new Response('').body as ReadableStream<Uint8Array>,
                        stderr: new Response(`credential ${targetSecret}\n`)
                            .body as ReadableStream<Uint8Array>,
                    };
                },
            }
        );

        expect(code).toBe(1);
        expect(JSON.stringify(events)).not.toContain(targetSecret);
        expect(events.at(-1)).toMatchObject({
            type: 'run.failed',
            data: {
                message: 'OpenCode exited with code 1: credential [REDACTED]',
            },
        });
    });

    test('cleans staged skills when runner launch throws', async () => {
        const fixture = await createFixture({ skill: true });
        let stagedDirectory = '';
        const events: WorkbenchEvent[] = [];

        const code = await WorkbenchRun.execute(
            {
                workbenchPath: fixture.packageDirectory,
                task: 'inspect',
                onEvent: (event) => {
                    events.push(event);
                },
            },
            {
                env: TEST_ENVIRONMENT,
                findExecutable: () => '/bin/opencode',
                spawn(_command, options) {
                    stagedDirectory = options.env.OPENCODE_CONFIG_DIR ?? '';
                    throw new Error('spawn failed');
                },
            }
        );

        expect(code).toBe(1);
        expect(events.at(-1)).toMatchObject({
            type: 'run.failed',
            data: { message: 'spawn failed' },
        });
        expect(stagedDirectory).not.toBe('');
        await expect(stat(stagedDirectory)).rejects.toThrow();
    });

    test('stages generated runner configuration as writable runtime state', async () => {
        const fixture = await createFixture({ skill: true });
        let assets: RuntimeAsset[] = [];
        const runtimeRegistry = new RuntimeRegistry([
            {
                name: 'local',
                async prepare(request) {
                    assets = request.assets;
                    return {
                        name: 'local',
                        workbench: request.workbench,
                        workspaceDirectory: request.workspaceDirectory,
                        environment: request.environment,
                        workspaces: [],
                        pathFor: (path) => path,
                        preflight: async () => ({
                            runner: { name: 'opencode', path: '/bin/opencode' },
                            tools: [],
                            enabledMcps: [],
                            disabledMcps: [],
                            optionalEnvironment: [],
                            workspaces: [],
                        }),
                        launch: () => ({
                            exited: Promise.resolve(0),
                            stdout: new Response('').body as ReadableStream<Uint8Array>,
                            stderr: new Response('').body as ReadableStream<Uint8Array>,
                        }),
                        execute: async () => ({
                            code: 0,
                            stdout: 'OpenRouter api\n',
                            stderr: '',
                        }),
                        interact: async () => 0,
                        cancel() {},
                        async cleanup() {},
                    };
                },
            },
        ]);

        const code = await WorkbenchRun.execute(
            { workbenchPath: fixture.packageDirectory, task: 'inspect' },
            { runtimeRegistry, env: TEST_ENVIRONMENT }
        );

        expect(code).toBe(0);
        const generated = assets.find(
            (asset) =>
                asset.path !== fixture.root && asset.path !== fixture.packageDirectory
        );
        expect(generated).toMatchObject({ access: 'read-write' });
    });

    test('terminates the runner and emits cancellation when requested', async () => {
        const fixture = await createFixture();
        const controller = new AbortController();
        const events: WorkbenchEvent[] = [];
        let killed = false;
        let finish!: (code: number) => void;
        const exited = new Promise<number>((resolve) => {
            finish = resolve;
        });

        const code = await WorkbenchRun.execute(
            {
                workbenchPath: fixture.packageDirectory,
                task: 'wait',
                signal: controller.signal,
                onEvent: (event) => {
                    events.push(event);
                },
            },
            {
                env: TEST_ENVIRONMENT,
                findExecutable: () => '/bin/opencode',
                spawn() {
                    queueMicrotask(() => controller.abort());
                    return {
                        exited,
                        stdout: new Response('').body as ReadableStream<Uint8Array>,
                        stderr: new Response('').body as ReadableStream<Uint8Array>,
                        kill() {
                            killed = true;
                            finish(143);
                        },
                    };
                },
            }
        );

        expect(code).toBe(130);
        expect(killed).toBeTrue();
        expect(events.at(-1)).toMatchObject({
            type: 'run.cancelled',
            data: { reason: 'requested' },
        });
        expect(events.some((event) => event.type === 'run.failed')).toBeFalse();
    });
});

async function createFixture(
    options: { tools?: string[]; skill?: boolean; runner?: string; env?: string[] } = {}
) {
    const root = await mkdtemp(join(tmpdir(), 'workbench-run-'));
    temporaryDirectories.push(root);
    const packageDirectory = join(root, '.workbenches', 'core');
    await mkdir(packageDirectory, { recursive: true });
    await writeFile(join(packageDirectory, 'instructions.md'), '# Instructions\n');
    if (options.skill) {
        const skillDirectory = join(packageDirectory, 'skills', 'fixture-skill');
        await mkdir(skillDirectory, { recursive: true });
        await writeFile(
            join(skillDirectory, 'SKILL.md'),
            '---\nname: fixture-skill\ndescription: Exercise cleanup.\n---\n'
        );
    }
    await writeFile(
        join(packageDirectory, 'workbench.yml'),
        [
            'spec: 0',
            'version: 0.1.0',
            'name: fixture-core',
            `runner: ${options.runner ?? 'opencode'}`,
            'model:',
            '  id: openai/gpt-5.6-terra',
            'instructions: ./instructions.md',
            ...(options.skill
                ? ['skills:', '  - ./skills/fixture-skill']
                : ['skills: []']),
            ...(options.tools?.length
                ? ['tools:', ...options.tools.map((tool) => `  - ${tool}`)]
                : ['tools: []']),
            'mcps: []',
            ...(options.env?.length
                ? [
                      'env:',
                      ...options.env.flatMap((name) => [
                          `  ${name}:`,
                          '    required: true',
                      ]),
                  ]
                : ['env: {}']),
            'runtime: local',
            '',
        ].join('\n')
    );
    return { root, packageDirectory };
}
