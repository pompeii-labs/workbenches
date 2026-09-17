import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { OutcomeStore, type RunOutcome } from '../../src/outcomes/index.js';
import { RunStore } from '../../src/runs/index.js';

const projectDirectory = resolve(import.meta.dir, '..', '..');
const cliPath = join(projectDirectory, 'src', 'cli.ts');
const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories
            .splice(0)
            .map((directory) => rm(directory, { recursive: true, force: true }))
    );
});

describe('wb outcome', () => {
    test('resolves runs, reports JSON, applies changes, and exports review bundles', async () => {
        const home = await temporaryDirectory('workbench-outcome-command-home-');
        const workspace = await temporaryDirectory(
            'workbench-outcome-command-workspace-'
        );
        const store = new OutcomeStore(home);
        const content = await store.putBytes('from the sandbox\n', 'text/plain');
        const runs = new RunStore(home);
        const run = await runs.create({
            metadata: {
                workbench: 'fixture',
                workbench_version: '0.1.0',
                runner: 'opencode',
                model: 'openai/gpt-test',
                runtime: 'e2b',
                workspace,
            },
            request: {
                workbench_path: '/fixture',
                workspace,
                task: 'Create a result',
            },
        });
        const outcome: RunOutcome = {
            version: 1,
            id: OutcomeStore.createId(),
            run_id: run.id,
            created_at: '2026-09-15T12:00:00.000Z',
            completeness: 'complete',
            summary: 'Created the result.',
            changesets: [
                {
                    id: 'change_primary',
                    workspace: { kind: 'primary' },
                    base: { snapshot_digest: `sha256:${'0'.repeat(64)}` },
                    entries: [
                        {
                            path: 'result.txt',
                            operation: 'add',
                            after: { kind: 'file', mode: 0o644, content },
                        },
                    ],
                    stats: {
                        additions: 1,
                        modifications: 0,
                        deletions: 0,
                        binary_files: 0,
                    },
                },
            ],
            artifacts: [],
            links: [
                {
                    id: 'link_preview_1',
                    label: 'Preview',
                    uri: 'https://example.com',
                    kind: 'preview',
                },
            ],
            warnings: [],
        };
        await store.commit(outcome, 'pending');
        await runs.update(run.id, { status: 'completed', outcome_id: outcome.id });

        const inspected = await executeCli(home, ['outcome', run.id, '--json']);
        expect(inspected.code).toBe(0);
        expect(JSON.parse(inspected.stdout)).toMatchObject({
            outcome: { id: outcome.id, run_id: run.id },
            application: { state: 'pending' },
        });

        const applied = await executeCli(home, ['outcome', outcome.id, '--apply']);
        expect(applied.code).toBe(0);
        expect(await readFile(join(workspace, 'result.txt'), 'utf8')).toBe(
            'from the sandbox\n'
        );
        expect((await store.receipt(outcome.id)).state).toBe('applied');

        const destination = join(home, 'review');
        const exported = await executeCli(home, [
            'outcome',
            outcome.id,
            '--export',
            destination,
            '--json',
        ]);
        expect(exported.code).toBe(0);
        expect(JSON.parse(exported.stdout).action).toEqual({
            type: 'export',
            path: destination,
        });
        expect(await readFile(join(destination, 'outcome.json'), 'utf8')).toContain(
            outcome.id
        );
    });

    test('rejects conflicting actions and runs without outcomes', async () => {
        const home = await temporaryDirectory('workbench-outcome-command-home-');
        const workspace = await temporaryDirectory(
            'workbench-outcome-command-workspace-'
        );
        const run = await new RunStore(home).create({
            metadata: {
                workbench: 'fixture',
                workbench_version: '0.1.0',
                runner: 'pi',
                model: 'openai/gpt-test',
                workspace,
            },
            request: {
                workbench_path: '/fixture',
                workspace,
                task: 'Do work',
            },
        });
        const missing = await executeCli(home, ['outcome', run.id]);
        expect(missing.code).toBe(1);
        expect(missing.stderr).toContain('has no outcome');

        const conflicting = await executeCli(home, [
            'outcome',
            run.id,
            '--apply',
            '--export',
            join(home, 'review'),
        ]);
        expect(conflicting.code).toBe(1);
        expect(conflicting.stderr).toContain(
            '--apply and --export cannot be used together'
        );
    });
});

async function temporaryDirectory(prefix: string): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), prefix));
    temporaryDirectories.push(directory);
    return directory;
}

async function executeCli(
    home: string,
    args: string[]
): Promise<{ code: number; stdout: string; stderr: string }> {
    const executable = process.env.WORKBENCH_OUTCOME_CLI
        ? [process.env.WORKBENCH_OUTCOME_CLI]
        : [process.execPath, cliPath];
    const environment = Object.fromEntries(
        ['PATH', 'HOME', 'TMPDIR', 'USER', 'LANG', 'LC_ALL', 'TERM'].flatMap((name) =>
            process.env[name] ? [[name, process.env[name] as string]] : []
        )
    );
    const child = Bun.spawn([...executable, ...args], {
        cwd: projectDirectory,
        env: { ...environment, WORKBENCH_HOME: home, NO_COLOR: '1' },
        stdout: 'pipe',
        stderr: 'pipe',
    });
    const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
    ]);
    return { code, stdout, stderr };
}
