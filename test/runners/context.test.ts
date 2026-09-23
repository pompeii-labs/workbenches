import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    remapRunnerContext,
    runtimeContext,
    stageRunnerContext,
    withRunnerContext,
} from '../../src/runners/context.js';
import { stageOpenCodeSkills } from '../../src/runners/opencode/assets.js';
import {
    buildOpenCodeInvocation,
    buildOpenCodeServerInvocation,
} from '../../src/runners/opencode/invocation.js';
import { stagePiConfig } from '../../src/runners/pi/assets.js';
import {
    buildPiInvocation,
    buildPiRpcInvocation,
} from '../../src/runners/pi/invocation.js';
import type { ResolvedWorkbench } from '../../src/types.js';

const directories: string[] = [];

afterEach(async () => {
    await Promise.all(
        directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
    );
});

describe('engine-owned runner context', () => {
    test('keeps the protocol and exact package instructions ahead of runtime facts', async () => {
        const { root, workbench } = await fixture();
        const native = '# Native package settings';
        const context = await stageRunnerContext(root, workbench, native);
        const prefix = await readFile(context.prefix, 'utf8');
        expect(prefix).toStartWith('<workbench_context>');
        expect(prefix).toContain('<workbench_package name="probe" version="0.1.0" />');
        expect(prefix).toEndWith(
            `${native}\n\n# Authored behavior\n\nDo the requested work.\n`
        );
        expect(prefix).not.toContain('<workbench_runtime>');
        expect(prefix).not.toContain(root);
        expect(prefix).not.toContain('workbenches.dev');
        expect(prefix).not.toContain('publisher=');
        expect(prefix).not.toContain('author=');
        const example = prefix
            .split('\n')
            .find((line) => line.startsWith('{"version":1'));
        expect(JSON.parse(example ?? '')).toMatchObject({
            version: 1,
            artifacts: [{ path: 'reports/findings.html' }],
        });
    });

    test('routes requested files without requiring users to name the outbox', async () => {
        const { root, workbench } = await fixture();
        const context = await stageRunnerContext(root, workbench);
        const prefix = await readFile(context.prefix, 'utf8');
        expect(prefix).toContain(
            'The user never needs to know, name, or opt into the outbox'
        );
        expect(prefix).toContain('write the finished file in the outbox');
        expect(prefix).toContain('Pasting its content in chat, naming a file');
        expect(prefix).toContain(
            'record that actual URL in outcome.json automatically'
        );
        expect(prefix).toContain('Never write it alongside the outbox');
        expect(prefix).toContain('copy its original bytes there');
        expect(prefix).toContain('without changing retained earlier artifacts');
        expect(prefix).toContain('belong in the appropriate workspace, not the outbox');
        expect(prefix).toContain('do not manufacture an attachment for every response');
        expect(prefix).toContain('prefer the quoted "$WORKBENCH_OUTPUT_DIR" variable');
        expect(prefix).toContain('never guess its spelling or reconstruct a run ID');
    });

    test('describes only selected workspace facts and never serializes credentials', async () => {
        const { workbench } = await fixture();
        workbench.manifest.workspaces = {
            notes: { required: true, access: 'read-only' },
            'source-code': { required: false, access: 'read-write' },
            unbound: { required: false, access: 'read-write' },
        };
        const context = runtimeContext(workbench, '/workspace', {
            WORKBENCH_OUTPUT_DIR: '/outbox',
            WORKBENCH_WORKSPACE_NOTES: '/notes',
            WORKBENCH_WORKSPACE_SOURCE_CODE: '/sources',
            WORKBENCH_WORKSPACE_UNDECLARED: '/not-selected',
            OPENAI_API_KEY: 'must-not-enter-context',
            WORKBENCH_CREDENTIALS_DIR: '/private-credentials',
        });
        expect(context).toContain(
            'name="primary" access="read-write" path="/workspace"'
        );
        expect(context).toContain('name="notes" access="read-only" path="/notes"');
        expect(context).toContain(
            'name="source-code" access="read-write" path="/sources"'
        );
        expect(context).toContain('environment="WORKBENCH_OUTPUT_DIR" path="/outbox"');
        expect(context).toContain('<declaration path="/outbox/outcome.json" />');
        expect(context).toContain(
            'prior session deliverables are restored here as independent working copies'
        );
        expect(context).toContain('find "$WORKBENCH_OUTPUT_DIR" -type f');
        expect(context).toContain(
            'Do not reuse absolute paths from earlier tool calls'
        );
        expect(context).toContain(
            'not evidence that the outbox is unavailable or read-only'
        );
        for (const value of [
            'must-not-enter-context',
            'OPENAI_API_KEY',
            'private-credentials',
            'not-selected',
            'unbound',
        ]) {
            expect(context).not.toContain(value);
        }
    });

    test('escapes package identity and runtime values instead of allowing XML structure', async () => {
        const { root, workbench } = await fixture();
        workbench.manifest.name = 'probe" /><injected>&';
        workbench.manifest.version = "0.1.0'";
        const files = await stageRunnerContext(root, workbench);
        const prefix = await readFile(files.prefix, 'utf8');
        expect(prefix).toContain('name="probe&quot; /&gt;&lt;injected&gt;&amp;"');
        expect(prefix).not.toContain('<injected>');
        const runtime = runtimeContext(workbench, '/a"\n<injected>', {
            WORKBENCH_OUTPUT_DIR: '/b&c',
        });
        expect(runtime).toContain('path="/a&quot;&#10;&lt;injected&gt;"');
        expect(runtime).toContain('path="/b&amp;c"');
    });

    test('states actual application semantics for every supported runtime and an unavailable outbox', async () => {
        const { workbench } = await fixture();
        for (const runtime of ['local', 'docker', 'e2b'] as const) {
            workbench.manifest.runtime = runtime;
            const context = runtimeContext(workbench, '/workspace', {});
            expect(context).toContain(`<runtime>${runtime}</runtime>`);
            expect(context).toContain('<outbox available="false" />');
            expect(context).not.toContain('<declaration');
            expect(context).toContain(
                runtime === 'e2b'
                    ? 'pending until the caller explicitly applies'
                    : 'change the host immediately'
            );
        }
    });

    test('assembles context without shell interpolation, extra model calls, or accumulating old runtime blocks', async () => {
        const { root, workbench } = await fixture();
        const files = await stageRunnerContext(root, workbench);
        const marker = join(root, 'should-not-exist');
        const outbox = `/output $(touch ${marker}) \`touch ${marker}\` $VARIABLE \\n`;
        const invocation = withRunnerContext(
            {
                command: [
                    '/bin/sh',
                    '-c',
                    'printf "%s" "$1"',
                    'probe',
                    'original task',
                ],
                cwd: root,
                env: { WORKBENCH_OUTPUT_DIR: outbox },
            },
            workbench,
            files
        );
        expect(invocation.env.WORKBENCH_RUNTIME_CONTEXT).not.toMatch(/[\r\n]/);
        const first = await run(invocation);
        expect(first).toEqual({ code: 0, stdout: 'original task', stderr: '' });
        const prefix = await readFile(files.prefix, 'utf8');
        const assembled = await readFile(files.instructions, 'utf8');
        expect(assembled).toStartWith(prefix);
        expect(assembled).toContain(outbox);
        expect(assembled.split('<workbench_runtime>')).toHaveLength(2);
        await expect(readFile(marker)).rejects.toThrow();
        await run(invocation);
        expect(await readFile(files.instructions, 'utf8')).toBe(assembled);
        const resumed = withRunnerContext(
            {
                ...invocation,
                command: ['true'],
                env: { WORKBENCH_OUTPUT_DIR: '/new-outbox' },
            },
            workbench,
            files
        );
        expect((await run(resumed)).code).toBe(0);
        const refreshed = await readFile(files.instructions, 'utf8');
        expect(refreshed).toStartWith(prefix);
        expect(refreshed).toContain('/new-outbox');
        expect(refreshed).not.toContain(outbox);
        expect(refreshed.split('<workbench_runtime>')).toHaveLength(2);
        expect(await readFile(files.prefix, 'utf8')).toBe(prefix);
    });

    test('rejects a package-owned staging namespace or a symlink instruction target', async () => {
        const first = await fixture();
        await mkdir(join(first.root, '.workbench-context'));
        await expect(stageRunnerContext(first.root, first.workbench)).rejects.toThrow();
        const second = await fixture();
        const original = join(second.root, 'original.md');
        await writeFile(original, 'must not change');
        const target = join(second.root, 'APPEND_SYSTEM.md');
        await symlink(original, target);
        await expect(
            stageRunnerContext(second.root, second.workbench, '', target)
        ).rejects.toThrow('regular file');
        expect(await readFile(original, 'utf8')).toBe('must not change');
    });

    test('binds native OpenCode instructions for both one-shot and server launches without changing user input', async () => {
        const { workbench } = await fixture();
        workbench.manifest.runner = 'opencode';
        const staged = await stageOpenCodeSkills(workbench);
        try {
            const env = { WORKBENCH_OUTPUT_DIR: '/output' };
            const oneShot = buildOpenCodeInvocation(
                workbench,
                'user task',
                env,
                staged.directory,
                '/workspace',
                'openai/gpt-5.6-sol',
                undefined,
                staged.context
            );
            const server = buildOpenCodeServerInvocation(
                workbench,
                'password',
                env,
                staged.directory,
                '/workspace',
                'openai/gpt-5.6-sol',
                undefined,
                undefined,
                { hostname: '127.0.0.1', port: 0 },
                staged.context
            );
            for (const invocation of [oneShot, server]) {
                expect(invocation.command).toContain('workbench-context');
                expect(
                    JSON.parse(invocation.env.OPENCODE_CONFIG_CONTENT ?? '{}')
                        .instructions
                ).toEqual([staged.context.instructions]);
                expect(
                    JSON.parse(invocation.env.OPENCODE_CONFIG_CONTENT ?? '{}')
                        .permission
                ).toEqual({
                    task: 'deny',
                    external_directory: { '/output/*': 'allow' },
                });
                expect(invocation.env.WORKBENCH_RUNTIME_CONTEXT).toContain('/output');
                expect(invocation.env.WORKBENCH_CONTEXT_PREFIX).toBe(
                    staged.context.prefix
                );
            }
            expect(oneShot.command.at(-1)).toBe('user task');
            expect(server.command).toContain('serve');
            expect(await readFile(workbench.instructionsPath, 'utf8')).toBe(
                '# Authored behavior\n\nDo the requested work.\n'
            );
        } finally {
            await staged.cleanup();
        }
    });

    test('does not grant unrelated directory access or interpret wildcard outbox paths as permissions', async () => {
        const { workbench } = await fixture();
        workbench.manifest.runner = 'opencode';
        for (const path of [
            undefined,
            '/tmp/outbox*',
            '/tmp/outbox?',
            '/tmp/outbox\\x',
        ]) {
            const invocation = buildOpenCodeInvocation(workbench, 'task', {
                WORKBENCH_OUTPUT_DIR: path,
            });
            expect(
                JSON.parse(invocation.env.OPENCODE_CONFIG_CONTENT ?? '{}').permission
            ).toEqual({ task: 'deny' });
        }
    });

    test('binds Pi native append instructions before credential staging in JSON and RPC modes', async () => {
        const { workbench } = await fixture();
        const staged = await stagePiConfig(workbench, {});
        try {
            const env = {
                WORKBENCH_OUTPUT_DIR: '/output',
                WORKBENCH_CREDENTIALS_DIR: '/credentials',
            };
            const oneShot = buildPiInvocation(
                workbench,
                'user task',
                env,
                '/workspace',
                'openai/gpt-5.6-sol',
                staged.directory,
                staged.context
            );
            const rpc = buildPiRpcInvocation(
                workbench,
                env,
                '/workspace',
                'openai/gpt-5.6-sol',
                staged.directory,
                undefined,
                staged.context
            );
            for (const invocation of [oneShot, rpc]) {
                expect(invocation.command[3]).toBe('workbench-context');
                expect(invocation.command[7]).toBe('workbench-pi');
                expect(invocation.env.WORKBENCH_CONTEXT_FILE).toBe(
                    join(staged.directory, 'APPEND_SYSTEM.md')
                );
                expect(invocation.env.WORKBENCH_RUNTIME_CONTEXT).toContain('/output');
            }
            expect(oneShot.command.at(-1)).toBe('user task');
            expect(rpc.command).toContain('rpc');
            expect(
                remapRunnerContext(staged.context, (path) => `/runtime${path}`)
            ).toEqual({
                prefix: `/runtime${staged.context.prefix}`,
                instructions: `/runtime${staged.context.instructions}`,
            });
        } finally {
            await staged.cleanup();
        }
    });
});

async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'workbench-context-test-'));
    directories.push(root);
    const packageDirectory = join(root, 'package');
    await mkdir(packageDirectory);
    const instructionsPath = join(packageDirectory, 'instructions.md');
    await writeFile(
        instructionsPath,
        '# Authored behavior\n\nDo the requested work.\n'
    );
    const workbench: ResolvedWorkbench = {
        manifestPath: join(packageDirectory, 'workbench.yml'),
        packageDirectory,
        repositoryDirectory: root,
        instructionsPath,
        skills: [],
        manifest: {
            spec: 0,
            version: '0.1.0',
            name: 'probe',
            runner: 'pi',
            model: { id: 'openai/gpt-5.6-sol' },
            instructions: './instructions.md',
            skills: [],
            tools: [],
            mcps: [],
            env: {},
            runtime: 'local',
        },
    };
    return { root, workbench };
}

async function run(invocation: ReturnType<typeof withRunnerContext>) {
    const process = Bun.spawn(invocation.command, {
        cwd: invocation.cwd,
        env: invocation.env,
        stdout: 'pipe',
        stderr: 'pipe',
    });
    const [code, stdout, stderr] = await Promise.all([
        process.exited,
        new Response(process.stdout).text(),
        new Response(process.stderr).text(),
    ]);
    return { code, stdout, stderr };
}
