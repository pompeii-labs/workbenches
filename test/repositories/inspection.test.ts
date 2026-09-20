import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { OutcomeStore } from '../../src/outcomes/store.js';
import { RepositoryInspection } from '../../src/repositories/inspection.js';
import { RepositoryDeliveryStore } from '../../src/repositories/receipts.js';
import { RunStore } from '../../src/runs/store.js';
import { loadOutcomeDialog } from '../../src/tui/dialog/outcome.js';
import { binding, GitHubFixture, result, saveRun, temporary } from './fixture.js';

describe('host-side repository inspection', () => {
    test('discovers and verifies a PR created with native gh from a result link', async () => {
        const home = await temporary();
        const initial = await result(home);
        const store = new OutcomeStore(home);
        const url = 'https://github.com/example/project/pull/1';
        const outcome = {
            ...initial,
            id: OutcomeStore.createId(),
            links: [
                {
                    id: 'link_pr',
                    label: 'Draft PR #1',
                    uri: url,
                    kind: 'pull_request' as const,
                },
            ],
        };
        await store.commit(outcome, 'present');
        await new RunStore(home).update(initial.run_id, { outcome_id: outcome.id });
        const github = new GitHubFixture();
        github.pull = {
            number: 1,
            html_url: url,
            state: 'open',
            merged: false,
            draft: true,
            base: { ref: binding.base_branch },
            head: {
                sha: 'f'.repeat(40),
                ref: 'docs-update',
                repo: { full_name: 'example/project' },
            },
        };
        const inspection = new RepositoryInspection(
            home,
            initial.run_id,
            {},
            github.client
        );
        expect(await inspection.load()).toMatchObject({
            native_pull: { number: 1, url },
            receipt: { state: 'published', commit: 'f'.repeat(40) },
        });
        await store.close();
    });
    test('reports the execution checkout instead of the caller directory across runtimes without GitHub access', async () => {
        const home = await temporary();
        const outcome = await result(home);
        const inspection = new RepositoryInspection(home, outcome.run_id, {});
        const checkout = join(home, 'sessions', binding.session_id, 'repository');
        expect(await inspection.load()).toMatchObject({
            checkout,
            workspace: checkout,
        });
        for (const runtime of ['docker', 'e2b']) {
            await new RunStore(home).update(outcome.run_id, { runtime });
            expect(await inspection.load()).toMatchObject({
                checkout,
                workspace: '/workspace',
            });
        }
    });

    test('keeps a verified PR visible on a later resumed run without publishing again', async () => {
        const home = await temporary();
        const store = new OutcomeStore(home);
        const outcome = await result(home);
        const url = 'https://github.com/example/project/pull/1';
        const linked = {
            ...outcome,
            id: OutcomeStore.createId(),
            links: [
                {
                    id: 'link_pr',
                    label: 'Draft PR #1',
                    uri: url,
                    kind: 'pull_request' as const,
                },
            ],
        };
        await store.commit(linked, 'present');
        await new RunStore(home).update(outcome.run_id, { outcome_id: linked.id });
        const continuation = RunStore.createId();
        await saveRun(home, binding, continuation, undefined, outcome.run_id);
        const github = new GitHubFixture();
        github.pull = {
            number: 1,
            html_url: url,
            state: 'open',
            merged: false,
            draft: true,
            base: { ref: binding.base_branch },
            head: {
                sha: 'f'.repeat(40),
                ref: 'docs-update',
                repo: { full_name: 'example/project' },
            },
        };
        const inspection = new RepositoryInspection(
            home,
            continuation,
            {},
            github.client
        );
        expect(await inspection.load()).toMatchObject({
            native_pull: { number: 1, url },
            receipt: { outcome_id: linked.id, state: 'published' },
        });
        expect(await inspection.load()).toMatchObject({
            receipt: { pull_request: { number: 1 } },
        });
        expect(github.calls.every((call) => call.method === 'GET')).toBeTrue();
        await store.close();
    });

    test('validates receipt provenance before inspection and never upgrades read-only authority', async () => {
        const home = await temporary();
        const outcome = await result(home);
        const github = new GitHubFixture();
        const receipt = {
            version: 1 as const,
            run_id: outcome.run_id,
            session_id: binding.session_id,
            outcome_id: outcome.id,
            repository: 'example/project',
            revision: binding.revision,
            base_branch: 'main',
            branch: `workbenches/${binding.session_id}`,
            created_at: new Date().toISOString(),
            state: 'failed' as const,
        };
        const receipts = new RepositoryDeliveryStore(home);
        await receipts.write(receipt);
        const inspection = new RepositoryInspection(
            home,
            outcome.run_id,
            {},
            github.client
        );
        await new RunStore(home).update(outcome.run_id, {
            repository: { ...binding, delivery: 'none' },
        });
        await receipts.write({ ...receipt, revision: 'c'.repeat(40) });
        await expect(inspection.load()).rejects.toThrow('provenance');
    });

    test('loads verified immutable diff content with bounded output and safe terminal text', async () => {
        const home = await temporary();
        const outcome = await result(home);
        const store = new OutcomeStore(home);
        const review = await store.putBytes(
            `diff --git a/test b/test\n+safe\u001b[31m\n${'x'.repeat(140 * 1024)}`,
            'text/x-diff'
        );
        const selected = {
            ...outcome,
            id: OutcomeStore.createId(),
            changesets: [
                {
                    id: 'change_primary',
                    workspace: { kind: 'primary' as const },
                    base: { snapshot_digest: `sha256:${'c'.repeat(64)}` as const },
                    entries: [],
                    stats: {
                        additions: 0,
                        modifications: 0,
                        deletions: 0,
                        binary_files: 0,
                    },
                    review,
                },
            ],
        };
        await store.commit(selected, 'pending');
        await store.close();
        const data = await loadOutcomeDialog(home, selected.id);
        expect(data.reviews?.[0]).toMatchObject({
            name: 'Workspace changes',
            truncated: true,
        });
        expect(data.reviews?.[0]?.text).toContain('+safe');
        expect(data.reviews?.[0]?.text).not.toContain('\u001b');
        expect(data.reviews?.[0]?.text.length).toBeLessThanOrEqual(128 * 1024);
    });
});
