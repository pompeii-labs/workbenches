import { afterEach, expect, spyOn, test } from 'bun:test';
import { createHash } from 'node:crypto';
import * as streams from 'node:fs';
import * as filesystem from 'node:fs/promises';
import { mkdtemp, open, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { OutcomeStore } from '../../src/outcomes/index.js';
import { WorkerApi } from '../../src/workers/api.js';
import {
    type WorkerOutcomeData,
    WorkerOutcomeLayout,
} from '../../src/workers/outcome.js';
import { isRecord } from '../../src/workers/protocol.js';
import { WorkerOutcomeRedaction } from '../../src/workers/redaction.js';
import { WorkerOutcomeUpload } from '../../src/workers/upload.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(names = ['large.bin']) {
    const directory = await mkdtemp(join(tmpdir(), 'workbench-upload-test-'));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const outcome: WorkerOutcomeData = {
        directory: join(directory, 'uploads'),
        files: names.map((path) => ({
            path,
            media_type: 'application/octet-stream',
            source: async () => join(directory, path),
        })),
        manifest: {
            summary: null,
            changesets: [],
            artifacts: [],
            links: [],
            warnings: [],
        },
    };
    return { directory, outcome };
}

test('redacts stream-boundary and JSON-escaped credentials without resizing, never short values', async () => {
    const { directory } = await fixture([]);
    const source = join(directory, 'source');
    const target = join(directory, 'redacted');
    const credential = 'FAKE_LONG_CREDENTIAL';
    const quoted = 'FAKE"QUOTED"KEY';
    const escaped = JSON.stringify(quoted).slice(1, -1);
    const prefix = 'x'.repeat(64 * 1024 - 5);
    const bytes = Buffer.from(`${prefix}${credential} ${escaped} true 1234 é`);
    await writeFile(source, bytes);
    const redaction = new WorkerOutcomeRedaction([
        credential,
        quoted,
        'true',
        '1234',
        'é',
        '',
    ]);
    const descriptor = await redaction.write(source, target);
    const result = await filesystem.readFile(target);
    expect(result.length).toBe(bytes.length);
    expect(result.toString()).toBe(
        `${prefix}[redacted]${'*'.repeat(credential.length - 10)} [redacted]${'*'.repeat(escaped.length - 10)} true 1234 é`
    );
    expect(descriptor).toEqual({
        size: bytes.length,
        sha256: createHash('sha256').update(result).digest('hex'),
    });
    expect(redaction.value({ summary: 'true', nested: [credential] })).toEqual({
        summary: 'true',
        nested: [`[redacted]${'*'.repeat(credential.length - 10)}`],
    });
});

function server(handler: (request: Request) => Promise<Response> | Response) {
    const http = Bun.serve({
        port: 0,
        fetch: handler,
        maxRequestBodySize: 100 * 1024 ** 2,
    });
    cleanups.push(() => {
        http.stop(true);
    });
    const api = new WorkerApi(http.url.toString());
    return new WorkerOutcomeUpload(api.request.bind(api), async () => {});
}

test('never sends the manifest as a file and uploads review diffs through all file steps', async () => {
    const { directory } = await fixture([]);
    const store = new OutcomeStore(directory);
    cleanups.push(() => store.close());
    const content = await store.putBytes('fake bytes', 'text/plain');
    const outcome = await store.commit(
        {
            version: 1,
            id: 'wbo_manifest1234567890123',
            run_id: 'wb_manifest12345678901234',
            created_at: '2026-01-01T00:00:00.000Z',
            completeness: 'complete',
            artifacts: [{ id: 'artifact_report', name: 'report.txt', content }],
            changesets: [
                {
                    id: 'change_primary',
                    workspace: { kind: 'primary' },
                    base: { snapshot_digest: `sha256:${'0'.repeat(64)}` },
                    entries: [],
                    review: content,
                    stats: {
                        additions: 0,
                        modifications: 0,
                        deletions: 0,
                        binary_files: 0,
                    },
                },
            ],
            links: [],
            warnings: [],
        },
        'present'
    );
    const layout = await new WorkerOutcomeLayout(directory).files(outcome);
    const begun: string[] = [];
    const steps: string[] = [];
    let path = '';
    let manifestsAsFiles = 0;
    let manifests = 0;
    const api = server(async (request) => {
        const endpoint = new URL(request.url).pathname;
        if (endpoint.endsWith('/files')) {
            const body = await request.json();
            if (!isRecord(body) || typeof body.path !== 'string')
                throw new Error('Invalid file');
            path = body.path;
            if (path === '.workbench/outcome.json') {
                manifestsAsFiles += 1;
                return Response.json(
                    {
                        code: 'reserved_path',
                        message: 'Manifest uses outcome completion',
                    },
                    { status: 400 }
                );
            }
            begun.push(path);
            steps.push(`begin ${path}`);
            return Response.json(
                { upload: 'fake-upload', part_bytes: 64 * 1024 ** 2 },
                { status: 201 }
            );
        }
        if (endpoint.includes('/parts/')) {
            expect(await request.text()).toBe('fake bytes');
            steps.push(`part ${path}`);
            return Response.json({ etag: 'fake-etag' });
        }
        if (endpoint.includes('/files/')) {
            steps.push(`complete ${path}`);
            return Response.json({ path, size: 10 });
        }
        manifests += 1;
        steps.push('manifest');
        expect(await request.json()).toEqual(layout.manifest);
        return Response.json({});
    });
    await api.uploadOutcome('run_fake', 'FAKE_TOKEN', layout, [], () => {});
    const review = '.workbench/changes/change_primary/review.diff';
    expect(begun).toEqual(['report.txt', review]);
    expect(manifestsAsFiles).toBe(0);
    expect(manifests).toBe(1);
    expect(steps).toEqual([
        'begin report.txt',
        'part report.txt',
        'complete report.txt',
        `begin ${review}`,
        `part ${review}`,
        `complete ${review}`,
        'manifest',
    ]);
});

test('streams redacted bytes across exact-size parts and deletes only after confirmation', async () => {
    const { directory, outcome } = await fixture();
    const partBytes = 64 * 1024 ** 2;
    const source = join(directory, 'large.bin');
    const credential = 'FAKE_CREDENTIAL_CROSSING_PART';
    const input = await open(source, 'w');
    await input.truncate(partBytes + 13);
    await input.write(Buffer.from(credential), 0, credential.length, partBytes - 20);
    await input.close();
    const expected = createHash('sha256');
    const zeros = Buffer.alloc(64 * 1024);
    let remaining = partBytes - 20;
    while (remaining > 0) {
        const length = Math.min(remaining, zeros.length);
        expected.update(zeros.subarray(0, length));
        remaining -= length;
    }
    const marker = '[redacted]'.padEnd(credential.length, '*');
    expected.update(marker);
    expected.update(Buffer.alloc(33 - credential.length));
    const digest = expected.digest('hex');
    const received = createHash('sha256');
    const calls: string[] = [];
    const parts: number[] = [];
    let staged = '';
    const api = server(async (request) => {
        expect(request.headers.get('authorization')).toBe('Bearer FAKE_RUN_TOKEN');
        const path = new URL(request.url).pathname;
        calls.push(path);
        if (path.endsWith('/files')) {
            expect(await request.json()).toEqual({
                path: 'large.bin',
                size: partBytes + 13,
                sha256: digest,
                ordinal: 0,
                media_type: 'application/octet-stream',
            });
            const copies = await readdir(outcome.directory);
            staged = join(outcome.directory, copies[0] ?? 'missing', 'content');
            expect((await stat(staged)).size).toBe(partBytes + 13);
            return Response.json(
                { upload: 'opaque/value', part_bytes: partBytes },
                { status: 201 }
            );
        }
        if (path.includes('/parts/')) {
            const number = Number(path.split('/').at(-1));
            const bytes = Buffer.from(await request.arrayBuffer());
            received.update(bytes);
            parts.push(bytes.length);
            if (number === 1)
                expect(bytes.subarray(-20).toString()).toBe(marker.slice(0, 20));
            else
                expect(bytes.subarray(0, credential.length - 20).toString()).toBe(
                    marker.slice(20)
                );
            expect((await stat(staged)).size).toBe(partBytes + 13);
            return Response.json({ etag: `part-${number}` });
        }
        if (path.includes('/files/')) {
            expect(received.digest('hex')).toBe(digest);
            expect(await request.json()).toEqual({
                parts: [
                    { number: 1, etag: 'part-1' },
                    { number: 2, etag: 'part-2' },
                ],
            });
            expect((await stat(staged)).size).toBe(partBytes + 13);
            return Response.json({ path: 'large.bin', size: partBytes + 13 });
        }
        expect(await stat(staged).catch(() => undefined)).toBeUndefined();
        expect(await request.json()).toEqual(outcome.manifest);
        return Response.json({});
    });
    const reads = spyOn(filesystem, 'readFile').mockImplementation(async () => {
        throw new Error('Whole-file reads are forbidden');
    });
    const streamsOpened = spyOn(streams, 'createReadStream');
    try {
        await api.uploadOutcome(
            'run_fake',
            'FAKE_RUN_TOKEN',
            outcome,
            [credential, 'FAKE_RUN_TOKEN'],
            () => {}
        );
        expect(parts).toEqual([partBytes, 13]);
        expect(calls.at(-1)).toBe('/v1/runs/run_fake/outcome/complete');
        expect(calls[1]).toContain('opaque%2Fvalue/parts/1');
        expect(reads).not.toHaveBeenCalled();
        expect(streamsOpened).toHaveBeenCalledWith(source, {
            highWaterMark: 64 * 1024,
        });
    } finally {
        reads.mockRestore();
        streamsOpened.mockRestore();
    }
});

test('skipped and stored files move on, failed parts warn, and the manifest goes last', async () => {
    const { directory, outcome } = await fixture([
        'skip.txt',
        'stored.txt',
        'retry.txt',
        'bad.txt',
        'budget.txt',
        'empty.txt',
    ]);
    for (const file of outcome.files)
        await writeFile(
            join(directory, file.path),
            file.path === 'empty.txt' ? '' : 'FAKE_SECRET'
        );
    outcome.manifest.summary = 'FAKE_SECRET';
    const calls: string[] = [];
    const attempts = new Map<string, number>();
    const messages: string[] = [];
    const begun: string[] = [];
    let current = '';
    const api = server(async (request) => {
        expect(request.headers.get('authorization')).toBe('Bearer FAKE_TOKEN');
        const path = new URL(request.url).pathname;
        calls.push(path);
        if (path.endsWith('/files')) {
            const body = await request.json();
            if (!isRecord(body) || typeof body.path !== 'string')
                throw new Error('Invalid begin request');
            current = body.path;
            expect(body.ordinal).toBe(begun.length);
            begun.push(current);
            if (current === 'skip.txt')
                return Response.json({
                    skipped: {
                        code: 'outcome_file_too_large',
                        message: 'Fake storage limit',
                    },
                });
            if (current === 'stored.txt') return Response.json({ stored: true });
            return Response.json({ upload: current, part_bytes: 4 }, { status: 201 });
        }
        if (path.includes('/parts/')) {
            const count = (attempts.get(path) ?? 0) + 1;
            attempts.set(path, count);
            await request.arrayBuffer();
            if (current === 'bad.txt')
                return Response.json(
                    { code: 'invalid_part', message: 'Fake invalid part' },
                    { status: 400 }
                );
            if (current === 'retry.txt' && count === 1)
                return Response.json(
                    { code: 'busy', message: 'Fake retry' },
                    { status: 503 }
                );
            return Response.json({ etag: 'fake-etag' });
        }
        if (path.includes('/files/')) {
            if (current === 'budget.txt')
                return Response.json({
                    skipped: {
                        code: 'outcome_file_too_large',
                        message: 'Fake budget filled',
                    },
                });
            if (current === 'empty.txt')
                expect(await request.json()).toEqual({ parts: [] });
            return Response.json({
                path: current,
                size: current === 'empty.txt' ? 0 : 11,
            });
        }
        const manifest = await request.json();
        if (!isRecord(manifest)) throw new Error('Invalid manifest');
        expect(manifest.summary).toBe('[redacted]*');
        expect(manifest.warnings).toEqual([
            {
                code: 'outcome_file_too_large',
                message: 'Skipped skip.txt: Fake storage limit',
            },
            {
                code: 'outcome_upload_failed',
                message: 'Could not upload bad.txt: Fake invalid part',
            },
            {
                code: 'outcome_file_too_large',
                message: 'Skipped budget.txt: Fake budget filled',
            },
        ]);
        return Response.json({});
    });
    await api.uploadOutcome(
        'run_fake',
        'FAKE_TOKEN',
        outcome,
        ['FAKE_SECRET'],
        (message) => messages.push(message)
    );
    expect(attempts.get('/v1/runs/run_fake/outcome/files/retry.txt/parts/1')).toBe(2);
    expect(attempts.get('/v1/runs/run_fake/outcome/files/bad.txt/parts/1')).toBe(1);
    expect(calls.at(-1)).toBe('/v1/runs/run_fake/outcome/complete');
    expect(begun).toEqual(outcome.files.map((file) => file.path));
    expect(messages).toEqual([
        'Fake storage limit',
        'Fake invalid part',
        'Fake budget filled',
    ]);
    expect(await readdir(outcome.directory)).toEqual([]);
});

test('retries interrupted response bodies and network failures without changing the manifest', async () => {
    const { outcome } = await fixture([]);
    let attempts = 0;
    const api = new WorkerApi('http://localhost', async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('Fake network failure');
        if (attempts === 2)
            return new Response(
                new ReadableStream({
                    start(controller) {
                        controller.error(new Error('Fake interrupted response'));
                    },
                })
            );
        return Response.json({});
    });
    await new WorkerOutcomeUpload(api.request.bind(api), async () => {}).uploadOutcome(
        'run_fake',
        'FAKE_TOKEN',
        outcome,
        [],
        () => {}
    );
    expect(attempts).toBe(3);
});

for (const status of [401, 404, 409]) {
    test(`does not retry HTTP ${status} and prints its unchanged error`, async () => {
        const { outcome } = await fixture([]);
        let attempts = 0;
        const api = server(() => {
            attempts += 1;
            return Response.json(
                { code: 'fake_error', message: 'Fake server explanation' },
                { status }
            );
        });
        await expect(
            api.uploadOutcome('run_fake', 'FAKE_TOKEN', outcome, [], () => {})
        ).rejects.toThrow('Fake server explanation');
        expect(attempts).toBe(1);
    });
}
