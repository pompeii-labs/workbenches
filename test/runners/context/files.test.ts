import { afterEach, describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { RunnerContext } from '../../../src/runners/context/files.js';
import { RunnerContextStaging } from '../../../src/runners/context/stage.js';
import { DiskRunnerFiles } from '../../../src/runners/files/disk.js';
import {
    buildOpenCodeInvocation,
    buildOpenCodeServerInvocation,
} from '../../../src/runners/opencode/invocation.js';
import { OpenCodeSkillStaging } from '../../../src/runners/opencode/skills.js';
import { PiConfigStaging } from '../../../src/runners/pi/config.js';
import {
    buildPiInvocation,
    buildPiRpcInvocation,
} from '../../../src/runners/pi/invocation.js';
import type { RunnerInvocation } from '../../../src/types.js';
import { fixture, removeFixtures } from './fixture.js';

afterEach(removeFixtures);

const files = new DiskRunnerFiles();
const staging = new RunnerContextStaging(files);
const skills = new OpenCodeSkillStaging(files, staging);
const config = new PiConfigStaging(files, staging);

describe('runner context files', () => {
    test('assembles context without shell interpolation, extra model calls, or accumulating old runtime blocks', async () => {
        const { root, workbench } = await fixture();
        const context = await staging.stage({ directory: root, workbench });
        const marker = join(root, 'should-not-exist');
        const outbox = `/output $(touch ${marker}) \`touch ${marker}\` $VARIABLE \\n`;
        const invocation = context.apply(
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
            workbench
        );
        expect(invocation.env.WORKBENCH_RUNTIME_CONTEXT).not.toMatch(/[\r\n]/);
        const first = await run(invocation);
        expect(first).toEqual({ code: 0, stdout: 'original task', stderr: '' });
        const prefix = await readFile(context.prefix, 'utf8');
        const assembled = await readFile(context.instructions, 'utf8');
        expect(assembled).toStartWith(prefix);
        expect(assembled).toContain(outbox);
        expect(assembled.split('<workbench_runtime>')).toHaveLength(2);
        await expect(readFile(marker)).rejects.toThrow();
        await run(invocation);
        expect(await readFile(context.instructions, 'utf8')).toBe(assembled);
        const resumed = context.apply(
            {
                ...invocation,
                command: ['true'],
                env: { WORKBENCH_OUTPUT_DIR: '/new-outbox' },
            },
            workbench
        );
        expect((await run(resumed)).code).toBe(0);
        const refreshed = await readFile(context.instructions, 'utf8');
        expect(refreshed).toStartWith(prefix);
        expect(refreshed).toContain('/new-outbox');
        expect(refreshed).not.toContain(outbox);
        expect(refreshed.split('<workbench_runtime>')).toHaveLength(2);
        expect(await readFile(context.prefix, 'utf8')).toBe(prefix);
    });

    test('remaps both files without changing the originals', () => {
        const context = new RunnerContext('/host/prefix.md', '/host/system.md');
        const remapped = context.remap((path) => `/runtime${path}`);
        expect(remapped).toEqual(
            new RunnerContext('/runtime/host/prefix.md', '/runtime/host/system.md')
        );
        expect(context.prefix).toBe('/host/prefix.md');
    });

    test('binds native OpenCode instructions for both one-shot and server launches without changing user input', async () => {
        const { workbench } = await fixture();
        workbench.manifest.runner = 'opencode';
        const staged = await skills.stage(workbench);
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
                ).toEqual({ external_directory: { '/output/*': 'allow' } });
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
            ).toBeUndefined();
        }
    });

    test('binds Pi native append instructions before credential staging in JSON and RPC modes', async () => {
        const { workbench } = await fixture();
        const staged = await config.stage(workbench, {}, {});
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
        } finally {
            await staged.cleanup();
        }
    });
});

async function run(invocation: RunnerInvocation) {
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
