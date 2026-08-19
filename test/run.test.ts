import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkbenchEvent } from '../src/execution.js';
import { runWorkbench } from '../src/run.js';

const temporaryDirectories: string[] = [];

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

        const code = await runWorkbench(
            {
                workbenchPath: fixture.packageDirectory,
                task: 'task',
                onEvent: (event) => {
                    events.push(event);
                },
            },
            {
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

        const code = await runWorkbench(
            {
                workbenchPath: fixture.packageDirectory,
                task: 'task',
                onEvent: (event) => {
                    events.push(event);
                },
            },
            {
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

        const code = await runWorkbench(
            {
                workbenchPath: fixture.packageDirectory,
                task: 'inspect',
                dryRun: true,
            },
            {
                env: { PATH: '/bin' },
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
        });
    });

    test('passes the translated command and environment to the runner', async () => {
        const fixture = await createFixture();
        let command: string[] = [];
        let cwd = '';
        let config = '';

        const code = await runWorkbench(
            { workbenchPath: fixture.packageDirectory, task: 'inspect' },
            {
                env: { PATH: '/fixture/bin' },
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
    });

    test('cleans staged skills when runner launch throws', async () => {
        const fixture = await createFixture({ skill: true });
        let stagedDirectory = '';
        const events: WorkbenchEvent[] = [];

        const code = await runWorkbench(
            {
                workbenchPath: fixture.packageDirectory,
                task: 'inspect',
                onEvent: (event) => {
                    events.push(event);
                },
            },
            {
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

    test('terminates the runner and emits cancellation when requested', async () => {
        const fixture = await createFixture();
        const controller = new AbortController();
        const events: WorkbenchEvent[] = [];
        let killed = false;
        let finish!: (code: number) => void;
        const exited = new Promise<number>((resolve) => {
            finish = resolve;
        });

        const code = await runWorkbench(
            {
                workbenchPath: fixture.packageDirectory,
                task: 'wait',
                signal: controller.signal,
                onEvent: (event) => {
                    events.push(event);
                },
            },
            {
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

async function createFixture(options: { tools?: string[]; skill?: boolean } = {}) {
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
