import { afterEach, describe, expect, test } from 'bun:test';
import {
    mkdir,
    mkdtemp,
    readFile,
    rm,
    stat,
    symlink,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
    OutcomeExporter,
    OutcomeLifecycle,
    OutcomeOutput,
    OutcomeStore,
    parseRunOutcome,
    type RunOutcome,
} from '../../src/outcomes/index.js';
import { RunStore } from '../../src/runs/store.js';

const homes: string[] = [];
const sessionId = 'wb_artifactsession1234567890';
afterEach(async () => {
    await Promise.all(
        homes.splice(0).map((home) => rm(home, { recursive: true, force: true }))
    );
});
async function home() {
    const directory = await mkdtemp(join(tmpdir(), 'workbench-artifact-tree-'));
    homes.push(directory);
    return directory;
}
function artifact(outcome: RunOutcome, path: string) {
    const file = outcome.artifacts.find((file) => file.path === path);
    if (!file) throw new Error(`Missing fixture artifact: ${path}`);
    return file;
}
async function snapshot(
    directory: string,
    files: Record<string, string | Uint8Array>,
    runId = RunStore.createId()
) {
    const output = await OutcomeOutput.create(directory, runId);
    const store = new OutcomeStore(directory);
    try {
        for (const [path, bytes] of Object.entries(files)) {
            await mkdir(dirname(join(output.directory, path)), { recursive: true });
            await writeFile(join(output.directory, path), bytes);
        }
        return await store.commit(
            {
                version: 1,
                id: OutcomeStore.createId(),
                run_id: runId,
                created_at: new Date().toISOString(),
                completeness: 'complete',
                ...(await output.collect(store)),
                changesets: [],
                warnings: [],
            },
            'present'
        );
    } finally {
        await output.cleanup();
        await store.close();
    }
}
async function run(
    directory: string,
    sequence: number,
    session = sessionId,
    status: 'completed' | 'failed' = 'completed'
) {
    const store = new RunStore(directory);
    const metadata = await store.create({
        metadata: {
            workbench: 'artifact-probe',
            workbench_version: '0.1.0',
            runner: 'opencode',
            model: 'openai/probe',
            runtime: 'e2b',
            workspace: directory,
            session_id: session,
        },
        request: { workbench_path: directory, workspace: directory, task: '' },
    });
    await store.update(metadata.id, {
        status,
        dispatched_at: `2026-09-17T12:00:${String(sequence).padStart(2, '0')}.000Z`,
    });
    return metadata.id;
}

describe('artifact trees and resume working copies', () => {
    test('opening an entrypoint materializes all sibling and nested assets, independent of display names', async () => {
        const directory = await home();
        const html =
            '<link rel="stylesheet" href="../assets/report.css"><img src="../assets/logo.svg">';
        const svg =
            '<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36"><rect width="36" height="36" fill="purple"/></svg>';
        const outcome = await snapshot(directory, {
            'reports/report.html': html,
            'assets/logo.svg': svg,
            'assets/report.css': 'body { color: purple; }',
            'other/report.html': '<h1>Other</h1>',
            'outcome.json': JSON.stringify({
                version: 1,
                artifacts: [{ path: 'reports/report.html', name: 'Pretty report' }],
            }),
        });
        const store = new OutcomeStore(directory);
        const artifact = outcome.artifacts.find(
            (file) => file.name === 'Pretty report'
        );
        if (!artifact) throw new Error('Missing report');
        expect(artifact.path).toBe('reports/report.html');
        const path = await store.artifactPath(outcome.id, artifact.id);
        expect(path).toEndWith('/files/reports/report.html');
        expect(
            await readFile(new URL('../assets/logo.svg', pathToFileURL(path)), 'utf8')
        ).toBe(svg);
        expect(
            await readFile(new URL('../assets/report.css', pathToFileURL(path)), 'utf8')
        ).toBe('body { color: purple; }');
        expect(
            await readFile(new URL('../other/report.html', pathToFileURL(path)), 'utf8')
        ).toBe('<h1>Other</h1>');
        expect(await readFile(path, 'utf8')).toBe(html);
        expect((await stat(path)).mode & 0o777).toBe(0o600);
        const exported = join(directory, 'export');
        await new OutcomeExporter(store).export(outcome, exported);
        expect(
            await readFile(
                join(exported, 'artifacts', 'reports', 'report.html'),
                'utf8'
            )
        ).toBe(html);
        expect(
            await readFile(join(exported, 'artifacts', 'assets', 'logo.svg'), 'utf8')
        ).toBe(svg);
        await writeFile(path, 'Edited preview only');
        expect(await readFile(await store.blob(artifact.content), 'utf8')).toBe(html);
    });

    test('old manifests without path still open sibling files without rewriting their retained metadata', async () => {
        const directory = await home();
        const store = new OutcomeStore(directory);
        const html = await store.putBytes('<img src="logo.svg">', 'text/html');
        const logo = await store.putBytes('<svg/>', 'image/svg+xml');
        const old: RunOutcome = {
            version: 1,
            id: OutcomeStore.createId(),
            run_id: RunStore.createId(),
            created_at: new Date().toISOString(),
            completeness: 'complete',
            changesets: [],
            artifacts: [
                { id: 'artifact_report', name: 'report.html', content: html },
                { id: 'artifact_logo', name: 'logo.svg', content: logo },
            ],
            links: [],
            warnings: [],
        };
        await store.commit(old, 'present');
        const path = await store.artifactPath(old.id, 'artifact_report');
        expect(await readFile(join(dirname(path), 'logo.svg'), 'utf8')).toBe('<svg/>');
        expect(await store.read(old.id)).toEqual(old);
        await store.close();
    });

    test('separate revision bundles retain both original bytes and their original supporting assets', async () => {
        const directory = await home();
        const first = await snapshot(directory, {
            'report.html': '<img src="logo.svg">ONE',
            'logo.svg': '<svg>ONE</svg>',
        });
        const second = await snapshot(directory, {
            'report.html': '<img src="logo.svg">TWO',
            'logo.svg': '<svg>TWO</svg>',
        });
        const store = new OutcomeStore(directory);
        const a = await store.artifactPath(first.id, artifact(first, 'report.html').id);
        const b = await store.artifactPath(
            second.id,
            artifact(second, 'report.html').id
        );
        expect(a).not.toBe(b);
        expect(await readFile(a, 'utf8')).toContain('ONE');
        expect(await readFile(join(dirname(a), 'logo.svg'), 'utf8')).toBe(
            '<svg>ONE</svg>'
        );
        expect(await readFile(b, 'utf8')).toContain('TWO');
        expect(await readFile(join(dirname(b), 'logo.svg'), 'utf8')).toBe(
            '<svg>TWO</svg>'
        );
    });

    test('restores latest file revisions across attempts, survives empty runs, and isolates sessions and previews', async () => {
        const directory = await home();
        const firstRun = await run(directory, 1);
        const original = await snapshot(
            directory,
            {
                'reports/report.html': 'ORIGINAL',
                'assets/logo.svg': '<svg>original-logo</svg>',
            },
            firstRun
        );
        const revisedRun = await run(directory, 2);
        await snapshot(directory, { 'reports/report.html': 'LATEST' }, revisedRun);
        // A failed final collection must not hide files already published live.
        await Bun.sleep(5);
        await snapshot(directory, {}, revisedRun);
        await snapshot(directory, {}, await run(directory, 3));
        await snapshot(directory, {}, await run(directory, 4, sessionId, 'failed'));
        await snapshot(
            directory,
            { 'reports/report.html': 'FOREIGN', 'private.txt': 'PRIVATE' },
            await run(directory, 5, RunStore.createId())
        );
        const store = new OutcomeStore(directory);
        const preview = await store.artifactPath(
            original.id,
            artifact(original, 'assets/logo.svg').id
        );
        await writeFile(preview, 'Edited preview');
        const available: string[] = [];
        const lifecycle = await OutcomeLifecycle.create({
            home: directory,
            runId: RunStore.createId(),
            resumeSessionId: sessionId,
            onAvailable: (outcome) => void available.push(outcome.id),
        });
        try {
            const report = join(lifecycle.output.directory, 'reports', 'report.html');
            const logo = join(lifecycle.output.directory, 'assets', 'logo.svg');
            expect(await readFile(report, 'utf8')).toBe('LATEST');
            expect(await readFile(logo, 'utf8')).toBe('<svg>original-logo</svg>');
            expect(
                await stat(join(lifecycle.output.directory, 'private.txt')).catch(
                    () => undefined
                )
            ).toBeUndefined();
            expect(
                await stat(join(lifecycle.output.directory, 'outcome.json')).catch(
                    () => undefined
                )
            ).toBeUndefined();
            expect(await lifecycle.checkpoint(undefined, 1)).toBeUndefined();
            expect(available).toEqual([]);
            await writeFile(report, 'VERSION TWO');
            const second = await lifecycle.checkpoint(undefined, 2);
            expect(second?.artifacts.map((file) => file.path)).toEqual([
                'assets/logo.svg',
                'reports/report.html',
            ]);
            expect(available).toHaveLength(1);
            expect(
                await readFile(
                    await store.blob(artifact(original, 'reports/report.html').content),
                    'utf8'
                )
            ).toBe('ORIGINAL');
        } finally {
            await lifecycle.cleanup();
        }
    });

    test('restores a retained supporting file omitted from a later snapshot in the same attempt', async () => {
        const directory = await home();
        const attempt = await run(directory, 1);
        await snapshot(
            directory,
            { 'report.html': 'ONE', 'logo.svg': '<svg/>' },
            attempt
        );
        await Bun.sleep(5);
        await snapshot(directory, { 'report.html': 'TWO' }, attempt);
        const lifecycle = await OutcomeLifecycle.create({
            home: directory,
            runId: RunStore.createId(),
            resumeSessionId: sessionId,
        });
        try {
            expect(
                await readFile(join(lifecycle.output.directory, 'report.html'), 'utf8')
            ).toBe('TWO');
            expect(
                await readFile(join(lifecycle.output.directory, 'logo.svg'), 'utf8')
            ).toBe('<svg/>');
        } finally {
            await lifecycle.cleanup();
        }
    });

    test('fresh sessions do not adopt any other session deliverables', async () => {
        const directory = await home();
        await snapshot(
            directory,
            { 'report.html': 'PRIVATE' },
            await run(directory, 1)
        );
        const lifecycle = await OutcomeLifecycle.create({
            home: directory,
            runId: RunStore.createId(),
        });
        try {
            expect(
                (await lifecycle.output.collect(new OutcomeStore(directory))).artifacts
            ).toEqual([]);
        } finally {
            await lifecycle.cleanup();
        }
    });

    test('corrupt retained content fails restore and removes only the newly created outbox', async () => {
        const directory = await home();
        const original = await snapshot(
            directory,
            { 'report.html': 'ORIGINAL' },
            await run(directory, 1)
        );
        const store = new OutcomeStore(directory);
        await writeFile(
            await store.blob(artifact(original, 'report.html').content),
            'CORRUPTED'
        );
        const runId = RunStore.createId();
        await expect(
            OutcomeLifecycle.create({
                home: directory,
                runId,
                resumeSessionId: sessionId,
            })
        ).rejects.toThrow('content');
        expect(
            await stat(join(directory, 'runs', runId, 'outbox')).catch(() => undefined)
        ).toBeUndefined();
        expect(await store.read(original.id)).toEqual(original);
    });

    for (const paths of [
        ['../outside.txt'],
        ['/tmp/outside.txt'],
        ['x/../outside.txt'],
        ['outcome.json'],
        ['same.txt', 'same.txt'],
        ['Same.txt', 'same.txt'],
        ['assets', 'assets/logo.svg'],
    ]) {
        test(`rejects unsafe or conflicting artifact paths: ${paths.join(', ')}`, async () => {
            const directory = await home();
            const valid = await snapshot(directory, { 'report.html': 'REPORT' });
            const artifacts = paths.map((path, index) => ({
                ...artifact(valid, 'report.html'),
                id: `artifact_${index}`,
                path,
            }));
            expect(() => parseRunOutcome({ ...valid, artifacts })).toThrow();
            await expect(
                new OutcomeExporter(new OutcomeStore(directory)).export(
                    { ...valid, artifacts },
                    join(directory, 'unsafe')
                )
            ).rejects.toThrow();
            expect(
                await stat(join(directory, 'unsafe')).catch(() => undefined)
            ).toBeUndefined();
        });
    }

    for (const nested of [false, true]) {
        test(`rejects symlinked ${nested ? 'nested' : 'root'} materialization directories`, async () => {
            const directory = await home();
            const outside = await home();
            const outcome = await snapshot(directory, { 'assets/logo.svg': '<svg/>' });
            const root = join(directory, 'outcomes', outcome.id, 'files');
            if (nested) await mkdir(root);
            await symlink(outside, nested ? join(root, 'assets') : root);
            await expect(
                new OutcomeStore(directory).artifactPath(
                    outcome.id,
                    artifact(outcome, 'assets/logo.svg').id
                )
            ).rejects.toThrow('real directories');
            expect(
                await stat(join(outside, 'logo.svg')).catch(() => undefined)
            ).toBeUndefined();
        });
    }
});
