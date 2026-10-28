import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { OutcomeStore, WorkspaceSnapshot } from '../../src/outcomes/index.js';
import { TarArchive } from '../../src/runtimes/staging/tar.js';
import { WorkerCheckout } from '../../src/workers/checkout.js';
import { WorkerOutcomeArchive } from '../../src/workers/outcome.js';
import { bareRepository } from './fixture.js';

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const decoder = new TextDecoder();

async function unpack(bytes: Uint8Array): Promise<Map<string, string>> {
    const archive = await TarArchive.gunzip(bytes);
    return new Map(
        archive
            .entries()
            .map((entry) => [entry.name, decoder.decode(entry.content)] as const)
    );
}

async function outcomeHome() {
    const home = await mkdtemp(join(tmpdir(), 'workbench-worker-outcome-'));
    cleanups.push(() => rm(home, { recursive: true, force: true }));
    return home;
}

describe('worker outcome archive', () => {
    test('stores a repository run in the layout of a cloud outcome', async () => {
        const remote = await bareRepository();
        cleanups.push(remote.cleanup);
        const home = await outcomeHome();
        const store = new OutcomeStore(home);
        const checkout = join(home, 'checkout');
        await mkdir(checkout);
        await new WorkerCheckout(remote.api).clone(
            {
                repository: 'acme/game',
                url: remote.url,
                ref: remote.commit,
                branch: 'wb/run_1',
                credential: null,
            },
            checkout,
            {
                PATH: process.env.PATH,
                HOME: home,
                GIT_CONFIG_NOSYSTEM: '1',
                GIT_CONFIG_GLOBAL: '/dev/null',
            }
        );
        // The run starts from the clone, so only its own edits are the change.
        const snapshot = await WorkspaceSnapshot.create(checkout, {
            workspace: { kind: 'primary' },
            baseline: 'git',
        });
        cleanups.push(() => snapshot.cleanup());
        await writeFile(join(checkout, 'notes.txt'), 'first\nsecond\n');
        await writeFile(join(checkout, 'added.txt'), 'new\n');
        await rm(join(checkout, 'README.md'));
        const changeset = await snapshot.collect(store);
        expect(changeset?.base.git_revision).toBe(remote.commit);
        const logo = await store.putBytes('<svg/>', 'image/svg+xml');
        const outcome = await store.commit(
            {
                version: 1,
                id: 'wbo_aaaaaaaaaaaaaaaaaaaaaaaa',
                run_id: 'wb_aaaaaaaaaaaaaaaaaaaaaaaa',
                created_at: '2026-01-01T00:00:00.000Z',
                completeness: 'complete',
                summary: 'Added a second note',
                changesets: changeset ? [changeset] : [],
                artifacts: [
                    {
                        id: 'artifact_logo',
                        name: 'Logo',
                        path: 'dist/logo.svg',
                        content: logo,
                    },
                ],
                links: [],
                warnings: [],
            },
            'present'
        );
        const files = await unpack(await new WorkerOutcomeArchive(home).pack(outcome));
        expect([...files.keys()].toSorted()).toEqual([
            '.workbench/changes/change_primary/added.txt',
            '.workbench/changes/change_primary/notes.txt',
            '.workbench/changes/change_primary/review.diff',
            '.workbench/outcome.json',
            'dist/logo.svg',
        ]);
        expect(files.get('dist/logo.svg')).toBe('<svg/>');
        expect(files.get('.workbench/changes/change_primary/notes.txt')).toBe(
            'first\nsecond\n'
        );
        const review = files.get('.workbench/changes/change_primary/review.diff');
        expect(review).toContain('+second');
        expect(review).toContain('--- a/README.md');
        expect(JSON.parse(files.get('.workbench/outcome.json') ?? '')).toEqual({
            summary: 'Added a second note',
            changesets: [
                {
                    id: 'change_primary',
                    workspace: { kind: 'primary' },
                    stats: {
                        additions: 1,
                        modifications: 1,
                        deletions: 1,
                        binary_files: 0,
                    },
                    entries: [
                        { path: 'README.md', operation: 'delete' },
                        { path: 'added.txt', operation: 'add' },
                        { path: 'notes.txt', operation: 'modify' },
                    ],
                },
            ],
            artifacts: [
                {
                    name: 'Logo',
                    path: 'dist/logo.svg',
                    description: null,
                    media_type: 'image/svg+xml',
                    size_bytes: 6,
                },
            ],
            links: [],
            warnings: [],
        });
    });

    test('keeps a run output out of the archive directory', async () => {
        const home = await outcomeHome();
        const store = new OutcomeStore(home);
        const content = await store.putBytes('x', 'text/plain');
        const outcome = await store.commit(
            {
                version: 1,
                id: 'wbo_bbbbbbbbbbbbbbbbbbbbbbbb',
                run_id: 'wb_bbbbbbbbbbbbbbbbbbbbbbbb',
                created_at: '2026-01-01T00:00:00.000Z',
                completeness: 'complete',
                changesets: [],
                artifacts: [
                    {
                        id: 'artifact_one',
                        name: 'Forged',
                        path: '.workbench/outcome.json',
                        content,
                    },
                    {
                        id: 'artifact_two',
                        name: 'Report',
                        path: 'report.txt',
                        content,
                    },
                ],
                links: [],
                warnings: [],
            },
            'present'
        );
        const files = await unpack(await new WorkerOutcomeArchive(home).pack(outcome));
        expect([...files.keys()].toSorted()).toEqual([
            '.workbench/outcome.json',
            'report.txt',
        ]);
        // The manifest is the archive's own, not the forged artifact's content.
        expect(files.get('.workbench/outcome.json')).not.toBe('x');
    });
});
