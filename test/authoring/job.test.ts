import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuthoringJob, type AuthoringJobRecord } from '../../src/authoring/job.js';
import { AuthoringOperation } from '../../src/authoring/operation.js';
import { RunStore } from '../../src/runs/store.js';
import { SessionSupervision } from '../../src/sessions/supervision.js';

const directories: string[] = [];
afterEach(async () => {
    await Promise.all(
        directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
    );
});

async function fixture() {
    const home = await mkdtemp(join(tmpdir(), 'authoring-job-'));
    directories.push(home);
    const operationId = 'author_fixture';
    const directory = join(home, 'authoring', operationId);
    await mkdir(directory, { recursive: true });
    const run = await new RunStore(home).create({
        metadata: {
            workbench: 'creator',
            workbench_version: '0.1.4',
            runner: 'opencode',
            model: 'openai/gpt-5.4-mini',
            workspace: home,
            mode: 'detached',
        },
        request: { workbench_path: home, workspace: home, task: 'brief' },
    });
    const record: AuthoringJobRecord = {
        version: 1,
        operation_id: operationId,
        session_id: run.id,
        run_id: run.id,
        status: 'running',
        pid: 2147483647,
    };
    const path = join(directory, 'job.json');
    await writeFile(path, JSON.stringify(record), { mode: 0o600 });
    await mkdir(join(home, 'authoring', 'runs'));
    await writeFile(
        join(home, 'authoring', 'runs', `${run.id}.json`),
        JSON.stringify({ operation_id: operationId })
    );
    return { home, directory, path, run, record, jobs: new AuthoringJob(home) };
}

describe('authoring verification supervision', () => {
    test('a stale running poll rereads a successful result after the worker exits', async () => {
        const f = await fixture();
        const completed = {
            ...f.record,
            status: 'completed' as const,
            result: {
                kind: 'create',
                packages: [
                    { selector: 'expert', path: '/fixture/.workbenches/expert' },
                ],
                changed_files: ['.workbenches/expert/workbench.yml'],
            },
        };
        await writeFile(f.path, JSON.stringify(completed));
        expect(await f.jobs.wait(f.record)).toEqual(completed);
    });

    test('a dead verification worker cannot produce a successful result or mutate history', async () => {
        const f = await fixture();
        const before = await readFile(f.path, 'utf8');
        const result = await f.jobs.wait(f.record);
        expect(result.status).toBe('failed');
        expect(result.result?.error).toContain('has not been verified');
        expect(await readFile(f.path, 'utf8')).toBe(before);
    });

    test('timeout and observer cancellation leave verification running', async () => {
        const f = await fixture();
        expect(await f.jobs.wait(f.record, { timeoutMilliseconds: 0 })).toEqual(
            f.record
        );
        expect(await f.jobs.wait(f.record, { signal: AbortSignal.abort() })).toEqual(
            f.record
        );
        expect((await f.jobs.forRun(f.run.id))?.status).toBe('running');
    });

    test('failed execution consumes private verification bindings without checkpointing their values', async () => {
        const f = await fixture();
        const repository = join(f.home, 'project');
        await mkdir(repository);
        const operation = await AuthoringOperation.prepare(f.home, {
            id: f.record.operation_id,
            kind: 'create',
            repository,
            creator: {
                version: '0.1.4',
                digest: 'fixture',
                registry_version_id: 'fixture',
                cached: true,
            },
        });
        await operation.checkpoint();
        await new RunStore(f.home).update(f.run.id, { status: 'failed', exit_code: 1 });
        await writeFile(f.path, JSON.stringify({ ...f.record, pid: process.pid }));
        const request = join(f.directory, 'verification.json');
        await writeFile(
            request,
            JSON.stringify({
                environment_overrides: {
                    file: { TOKEN: 'private-verification-value' },
                    explicit: [],
                },
            }),
            { mode: 0o600 }
        );
        expect((await stat(request)).mode & 0o777).toBe(0o600);
        expect(await f.jobs.execute(f.record.operation_id)).toBe(1);
        await expect(stat(request)).rejects.toMatchObject({ code: 'ENOENT' });
        const record = await f.jobs.forRun(f.run.id);
        expect(record?.status).toBe('failed');
        expect(record?.result?.error).toContain('Creator execution failed');
        expect(JSON.stringify(record)).not.toContain('private-verification-value');
        expect(
            await readFile(join(f.directory, 'operation.json'), 'utf8')
        ).not.toContain('private-verification-value');
    });

    test('completed native execution is not completed authoring while verification is running', async () => {
        const f = await fixture();
        await new RunStore(f.home).update(f.run.id, { status: 'completed' });
        await writeFile(f.path, JSON.stringify({ ...f.record, pid: process.pid }));
        const result = await new SessionSupervision(f.home).wait(f.run, {
            timeoutMilliseconds: 20,
        });
        expect(result).toMatchObject({
            state: 'timeout',
            run_state: 'completed',
            authoring: { status: 'running' },
        });
        expect((await f.jobs.forRun(f.run.id))?.status).toBe('running');
    });
});
