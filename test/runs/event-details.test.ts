import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ToolDetails } from '../../src/runners/details.js';
import { RunEventDetails } from '../../src/runs/event-details.js';
import type { WorkbenchEventDraft } from '../../src/runs/events.js';
import { WorkspacePatches } from '../../src/runs/workspace-patches.js';
import type { RuntimeCommandResult } from '../../src/runtimes/contracts.js';
import type { ResolvedWorkbench, RunnerInvocation } from '../../src/types.js';

const directories: string[] = [];

afterEach(async () => {
    await Promise.all(
        directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
    );
});

async function workspace(git: boolean): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'wb-event-details-'));
    directories.push(directory);
    await writeFile(join(directory, 'tracked.txt'), 'one\ntwo\n');
    if (git) {
        for (const command of [
            ['git', 'init', '-q'],
            ['git', 'add', 'tracked.txt'],
            [
                'git',
                '-c',
                'user.name=Workbench Test',
                '-c',
                'user.email=test@example.invalid',
                'commit',
                '-q',
                '-m',
                'initial',
            ],
        ]) {
            expect(Bun.spawnSync(command, { cwd: directory }).exitCode).toBe(0);
        }
    }
    return directory;
}

/** A runtime whose commands run on this machine, as the local runtime's do. */
function runtime(directory: string, commands: RunnerInvocation[] = []) {
    return {
        workspaceDirectory: directory,
        environment: { PATH: process.env.PATH },
        async execute(invocation: RunnerInvocation): Promise<RuntimeCommandResult> {
            commands.push(invocation);
            const child = Bun.spawn(invocation.command, {
                cwd: invocation.cwd,
                env: { PATH: invocation.env.PATH ?? '' },
                stdout: 'pipe',
                stderr: 'pipe',
            });
            const [code, stdout, stderr] = await Promise.all([
                child.exited,
                new Response(child.stdout).text(),
                new Response(child.stderr).text(),
            ]);
            return { code, stdout, stderr };
        },
    };
}

function workbench(): ResolvedWorkbench {
    return {
        manifestPath: '/package/workbench.yml',
        packageDirectory: '/package',
        repositoryDirectory: '/package',
        instructionsPath: '/package/instructions.md',
        skills: [],
        manifest: {
            spec: 0,
            version: '0.1.0',
            name: 'details',
            runner: 'opencode',
            model: { id: 'openai/gpt-5.6-terra' },
            instructions: './instructions.md',
            skills: [],
            tools: [],
            mcps: [],
            env: { DEPLOY_TARGET: { required: true } },
            runtime: 'local',
        },
    };
}

describe('run event details', () => {
    test('redacts every value the run injected that the adapter did not know', async () => {
        const adapter = new ToolDetails({ workspace: '/workspace' });
        const draft: WorkbenchEventDraft = {
            type: 'tool.completed',
            data: {
                id: 'call',
                name: 'bash',
                status: 'completed',
                ...adapter.input('bash', { command: 'deploy staging-east-zone' }),
                ...adapter.output('deployed to staging-east-zone'),
            },
        };
        const change: WorkbenchEventDraft = {
            type: 'file.changed',
            data: {
                path: '/workspace/a.txt',
                operation: 'write',
                ...adapter.diff('/workspace/a.txt', '', 'target staging-east-zone\n'),
            },
        };
        const secrets = RunEventDetails.secrets(workbench(), {
            DEPLOY_TARGET: 'staging-east-zone',
            PATH: '/usr/bin',
        });
        const details = new RunEventDetails(secrets);

        const completed = await details.complete(draft);
        const changed = await details.complete(change);
        const text = {
            type: 'output.text',
            data: { text: 'staging-east-zone' },
        } as const;

        expect(completed.data.input).toEqual({ command: 'deploy [REDACTED]' });
        expect(completed.data.output).toBe('deployed to [REDACTED]');
        expect(changed.data.patch).toBe(
            '--- a/a.txt\n+++ b/a.txt\n@@ -0,0 +1,1 @@\n+target [REDACTED]\n'
        );
        expect(changed.data.additions).toBe(1);
        expect(await details.complete(text)).toEqual(text);
        expect(secrets).not.toContain('/usr/bin');
    });

    test('computes a missing patch from the workspace through the runtime', async () => {
        const directory = await workspace(true);
        await writeFile(join(directory, 'tracked.txt'), 'one\nTWO\n');
        await writeFile(join(directory, 'new.txt'), 'fresh\n');
        const commands: RunnerInvocation[] = [];
        const details = new RunEventDetails(
            ['fresh-value-never-shown'],
            new WorkspacePatches(runtime(directory, commands))
        );

        const tracked = await details.complete({
            type: 'file.changed',
            data: { path: join(directory, 'tracked.txt'), operation: 'write' },
        });
        const created = await details.complete({
            type: 'file.changed',
            data: { path: 'new.txt', operation: 'write' },
        });
        const outside = await details.complete({
            type: 'file.changed',
            data: { path: '/elsewhere/x.txt', operation: 'write' },
        });

        expect(tracked.data).toEqual({
            path: join(directory, 'tracked.txt'),
            operation: 'write',
            patch: '--- a/tracked.txt\n+++ b/tracked.txt\n@@ -1,2 +1,2 @@\n one\n-two\n+TWO\n',
            additions: 1,
            deletions: 1,
        });
        expect(created.data).toEqual({
            path: 'new.txt',
            operation: 'write',
            patch: '--- a/new.txt\n+++ b/new.txt\n@@ -0,0 +1 @@\n+fresh\n',
            additions: 1,
            deletions: 0,
        });
        expect(outside.data).toEqual({ path: '/elsewhere/x.txt', operation: 'write' });
        expect(commands).toHaveLength(2);
        expect(commands.every((command) => command.env.PATH === process.env.PATH)).toBe(
            true
        );
    });

    test('reports a change without a patch outside a Git work tree', async () => {
        const directory = await workspace(false);
        const details = new RunEventDetails(
            [],
            new WorkspacePatches(runtime(directory))
        );
        expect(
            await details.complete({
                type: 'file.changed',
                data: { path: join(directory, 'tracked.txt'), operation: 'edit' },
            })
        ).toEqual({
            type: 'file.changed',
            data: { path: join(directory, 'tracked.txt'), operation: 'edit' },
        });
    });

    test('gives up on a workspace diff that does not answer in time', async () => {
        const patches = new WorkspacePatches(
            {
                workspaceDirectory: '/workspace',
                environment: {},
                execute: () => new Promise<RuntimeCommandResult>(() => {}),
            },
            10
        );
        expect(await patches.diff('/workspace/a.txt')).toBeUndefined();
    });

    test('delivers drafts in the order they arrived while a patch is computed', async () => {
        let release: () => void = () => {};
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const details = new RunEventDetails(
            [],
            new WorkspacePatches({
                workspaceDirectory: '/workspace',
                environment: {},
                execute: async () => {
                    await gate;
                    return { code: 0, stdout: '@@ -0,0 +1 @@\n+x\n', stderr: '' };
                },
            })
        );
        const delivered: string[] = [];
        const deliver = async (draft: WorkbenchEventDraft) => {
            delivered.push(draft.type);
        };
        const first = details.emit(
            {
                type: 'file.changed',
                data: { path: '/workspace/a', operation: 'write' },
            },
            deliver
        );
        const second = details.emit(
            { type: 'output.text', data: { text: 'x' } },
            deliver
        );
        await Bun.sleep(5);
        expect(delivered).toEqual([]);
        release();
        await Promise.all([first, second]);
        expect(delivered).toEqual(['file.changed', 'output.text']);
    });
});
