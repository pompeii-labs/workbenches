import { describe, expect, test } from 'bun:test';
import { RepositoryChecks } from '../../src/repositories/checks.js';
import { RepositoryGitHub } from '../../src/repositories/github.js';
import { RepositoryDeliveryStore } from '../../src/repositories/receipts.js';
import { binding, result, temporary } from './fixture.js';

async function fixture() {
    const home = await temporary();
    const outcome = await result(home);
    const head = 'f'.repeat(40);
    const branch = `workbenches/${binding.session_id}`;
    const url = 'https://github.com/example/project/pull/1';
    const receipts = new RepositoryDeliveryStore(home);
    await receipts.write({
        version: 1,
        run_id: outcome.run_id,
        session_id: binding.session_id,
        outcome_id: outcome.id,
        repository: 'example/project',
        revision: binding.revision,
        base_branch: 'main',
        branch,
        created_at: new Date().toISOString(),
        state: 'published',
        commit: head,
        tree: 'e'.repeat(40),
        pull_request: { number: 1, url },
    });
    const responses: Record<string, unknown> = {
        '/pulls/1': {
            number: 1,
            html_url: url,
            state: 'open',
            merged: false,
            base: { ref: 'main' },
            head: { sha: head, ref: branch, repo: { full_name: 'example/project' } },
        },
        [`/commits/${head}/check-runs`]: { total_count: 0, check_runs: [] },
        [`/commits/${head}/status`]: { total_count: 0, statuses: [] },
        '/actions/runs': { total_count: 0, workflow_runs: [] },
    };
    const requests: Array<{ url: string; authorization: string | null }> = [];
    const github = new RepositoryGitHub('protected-credential', (async (
        input,
        init
    ) => {
        const target = new URL(String(input));
        requests.push({
            url: target.href,
            authorization: new Headers(init?.headers).get('authorization'),
        });
        if (target.hostname === 'example.blob.core.windows.net')
            return new Response('failure details\n');
        const path = target.pathname.replace('/repos/example/project', '');
        if (path === '/actions/jobs/9/logs')
            return new Response(null, {
                status: 302,
                headers: {
                    location: 'https://example.blob.core.windows.net/log?signed=secret',
                },
            });
        if (!(path in responses)) throw new Error(`Unexpected request ${path}`);
        return Response.json(responses[path]);
    }) as typeof fetch);
    return {
        head,
        branch,
        responses,
        requests,
        checks: new RepositoryChecks(binding, receipts, github),
    };
}

describe('session-owned PR CI reads', () => {
    test('no checks is not passed; current-head pending and failures are distinguished', async () => {
        const f = await fixture();
        expect((await f.checks.read()).state).toBe('none');
        f.responses[`/commits/${f.head}/check-runs`] = {
            total_count: 1,
            check_runs: [
                {
                    id: 1,
                    name: 'test',
                    head_sha: f.head,
                    status: 'in_progress',
                    conclusion: null,
                    details_url: null,
                },
            ],
        };
        expect((await f.checks.read()).state).toBe('pending');
        f.responses[`/commits/${f.head}/check-runs`] = {
            total_count: 1,
            check_runs: [
                {
                    id: 1,
                    name: 'test',
                    head_sha: f.head,
                    status: 'completed',
                    conclusion: 'failure',
                    details_url: null,
                },
            ],
        };
        expect((await f.checks.read()).state).toBe('failed');
    });
    test('ignores old commits and older workflow attempts, but never claims a truncated read passed', async () => {
        const f = await fixture();
        const good = {
            id: 2,
            workflow_id: 1,
            head_sha: f.head,
            head_branch: f.branch,
            status: 'completed',
            conclusion: 'success',
            html_url: 'https://github.com/example/project/actions/runs/2',
            name: 'test',
        };
        f.responses['/actions/runs'] = {
            total_count: 3,
            workflow_runs: [
                good,
                { ...good, id: 1, conclusion: 'failure' },
                { ...good, id: 3, head_sha: 'a'.repeat(40), conclusion: 'failure' },
            ],
        };
        f.responses['/actions/runs/2/jobs'] = {
            total_count: 1,
            jobs: [
                {
                    id: 9,
                    run_id: 2,
                    head_sha: f.head,
                    status: 'completed',
                    conclusion: 'success',
                    name: 'test',
                },
            ],
        };
        expect(await f.checks.read()).toMatchObject({
            state: 'passed',
            jobs: [{ id: 9 }],
        });
        f.responses['/actions/runs'] = { total_count: 101, workflow_runs: [good] };
        expect(await f.checks.read()).toMatchObject({
            state: 'incomplete',
            truncated: true,
        });
    });
    test('validates CI job provenance and downloads signed logs without forwarding credentials', async () => {
        const f = await fixture();
        f.responses['/actions/jobs/9'] = {
            id: 9,
            run_id: 2,
            head_sha: f.head,
            name: 'test',
        };
        f.responses['/actions/runs/2'] = {
            id: 2,
            head_sha: f.head,
            head_branch: f.branch,
        };
        expect(await f.checks.logs(9)).toMatchObject({
            job_id: 9,
            text: 'failure details\n',
        });
        expect(f.requests.at(-1)?.authorization).toBeNull();
        expect(f.requests.at(-2)?.authorization).toBe('Bearer protected-credential');
        f.responses['/actions/jobs/9'] = { id: 9, run_id: 2, head_sha: 'a'.repeat(40) };
        const before = f.requests.filter((request) =>
            request.url.includes('/logs')
        ).length;
        await expect(f.checks.logs(9)).rejects.toThrow('does not belong');
        expect(
            f.requests.filter((request) => request.url.includes('/logs'))
        ).toHaveLength(before);
    });
    test('rejects a changed PR before requesting any CI data', async () => {
        const f = await fixture();
        (f.responses['/pulls/1'] as { head: { sha: string } }).head.sha = 'a'.repeat(
            40
        );
        await expect(f.checks.read()).rejects.toThrow('changed outside');
        expect(f.requests).toHaveLength(1);
    });

    test('rejects an untrusted log redirect before sending a download request', async () => {
        let requests = 0;
        const github = new RepositoryGitHub('protected-credential', (async () => {
            requests++;
            return new Response(null, {
                status: 302,
                headers: {
                    location: 'https://example.com/log?signed=secret',
                },
            });
        }) as unknown as typeof fetch);
        await expect(github.jobLogs('example', 'project', 9)).rejects.toThrow(
            'GitHub CI logs could not be downloaded'
        );
        expect(requests).toBe(1);
    });

    test('bounds CI log downloads and marks truncated output', async () => {
        let cancelled = false;
        const github = new RepositoryGitHub(
            undefined,
            (async () =>
                new Response(
                    new ReadableStream<Uint8Array>({
                        start(controller) {
                            controller.enqueue(new Uint8Array(256 * 1024).fill(65));
                        },
                        cancel() {
                            cancelled = true;
                        },
                    })
                )) as unknown as typeof fetch
        );
        const logs = await github.jobLogs('example', 'project', 9);
        expect(logs.truncated).toBe(true);
        expect(Buffer.byteLength(logs.text)).toBe(128 * 1024);
        expect(cancelled).toBe(true);
    });

    test('does not expose signed URLs or underlying errors when a log stream fails', async () => {
        const github = new RepositoryGitHub(
            'protected-credential',
            (async () =>
                new Response(
                    new ReadableStream<Uint8Array>({
                        start(controller) {
                            controller.error(
                                new Error(
                                    'https://example.blob.core.windows.net/log?signed=secret'
                                )
                            );
                        },
                    })
                )) as unknown as typeof fetch
        );
        let message = '';
        try {
            await github.jobLogs('example', 'project', 9);
        } catch (error) {
            message = (error as Error).message;
        }
        expect(message).toBe('GitHub CI logs could not be downloaded');
        expect(message).not.toContain('secret');
        expect(message).not.toContain('https://');
    });
});
