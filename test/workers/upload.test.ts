import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkerApi } from '../../src/workers/api.js';
import type { WorkerOutcomeData } from '../../src/workers/outcome.js';
import { WorkerOutcomeRedaction } from '../../src/workers/redaction.js';
import {
    type WorkerOutcomeRequest,
    WorkerOutcomeUpload,
} from '../../src/workers/upload.js';

const directories: string[] = [];
afterEach(async () => {
    for (const directory of directories.splice(0))
        await rm(directory, { recursive: true, force: true });
});

async function fixture(contents: Record<string, string>) {
    const directory = await mkdtemp(join(tmpdir(), 'workbench-upload-test-'));
    directories.push(directory);
    const outcome: WorkerOutcomeData = {
        files: [],
        manifest: {
            summary: null,
            changesets: [],
            artifacts: [],
            links: [],
            warnings: [],
        },
    };
    for (const [path, bytes] of Object.entries(contents)) {
        const source = join(directory, String(outcome.files.length));
        await writeFile(source, bytes);
        outcome.files.push({
            path,
            source: async () => source,
            content: {
                digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
                size_bytes: Buffer.byteLength(bytes),
                media_type: 'text/plain',
            },
        });
    }
    return { directory, outcome };
}

test('redacts every manifest string and key, including JSON-escaped credentials, but not short values', () => {
    const credential = 'FAKE"QUOTED"KEY';
    const redaction = new WorkerOutcomeRedaction([credential, 'true', '1234', 'é', '']);
    expect(
        redaction.value({
            [credential]: [
                credential,
                JSON.stringify(credential).slice(1, -1),
                'true',
                '1234',
                'é',
            ],
        })
    ).toEqual({
        '[redacted]*****': [
            '[redacted]*****',
            '[redacted]*******',
            'true',
            '1234',
            'é',
        ],
    });
    expect(JSON.stringify(redaction.value({ summary: credential }))).not.toContain(
        'FAKE'
    );
});

test('sends unchanged file slices to signed URLs without credentials and completes with exact ordered ETags', async () => {
    const secret = 'FAKE_SECRET_VALUE';
    const bytes = `start${secret}end`;
    const { directory, outcome } = await fixture({
        [`${secret}.txt`]: bytes,
        'empty.txt': '',
    });
    outcome.manifest.summary = secret;
    outcome.manifest.links = [
        { id: 'link_fake', label: secret, uri: `https://example.com/${secret}` },
    ];
    outcome.manifest.warnings = [{ code: secret, message: secret }];
    outcome.manifest.artifacts = [
        {
            name: secret,
            path: secret,
            description: secret,
            media_type: secret,
            size_bytes: bytes.length,
        },
    ];
    outcome.manifest.changesets = [
        {
            id: secret,
            workspace: { kind: 'named', name: secret },
            stats: { additions: 0, modifications: 1, deletions: 0, binary_files: 0 },
            entries: [{ path: secret, operation: 'modify' }],
        },
    ];
    const partBytes = 7;
    const counts = [Math.ceil(Buffer.byteLength(bytes) / partBytes), 1];
    const sent: Uint8Array[] = [];
    const completions: unknown[] = [];
    let fileIndex = -1;
    const request: WorkerOutcomeRequest = async (path, options) => {
        expect(options.token).toBe('FAKE_RUN_TOKEN');
        if (path.endsWith('/files')) {
            fileIndex += 1;
            const file = outcome.files[fileIndex];
            expect(options.body).toEqual({
                path: new WorkerOutcomeRedaction([secret]).text(file?.path ?? ''),
                size: file?.content.size_bytes,
                sha256: file?.content.digest.slice(7),
                ordinal: fileIndex,
                media_type: 'text/plain',
            });
            return {
                upload: `upload/${fileIndex}`,
                part_bytes: partBytes,
                parts: Array.from(
                    { length: counts[fileIndex] ?? 0 },
                    (_, index) => `https://storage.example/${fileIndex}/${index + 1}`
                ),
            };
        }
        if (path.includes('/files/')) {
            expect(path).toContain(`upload%2F${fileIndex}/complete`);
            completions.push(options.body);
            return {
                path: new WorkerOutcomeRedaction([secret]).text(
                    outcome.files[fileIndex]?.path ?? ''
                ),
                size: outcome.files[fileIndex]?.content.size_bytes,
            };
        }
        const manifest = JSON.stringify(options.body);
        expect(manifest).not.toContain(secret);
        expect(manifest).toContain('[redacted]');
        return {};
    };
    const uploader = new WorkerOutcomeUpload(
        request,
        async () => {},
        async (url, options) => {
            expect(options.method).toBe('PUT');
            const headers = new Headers(options.headers);
            expect(headers.has('authorization')).toBe(false);
            const part = new Uint8Array(await new Response(options.body).arrayBuffer());
            expect(headers.get('content-length')).toBe(String(part.length));
            sent.push(part);
            return new Response(null, {
                headers: { ETag: `"${url.split('/').at(-1)}-opaque"` },
            });
        }
    );
    await uploader.uploadOutcome(
        'run_fake',
        'FAKE_RUN_TOKEN',
        outcome,
        [secret],
        () => {}
    );
    expect(sent.map((part) => Buffer.from(part).toString())).toEqual([
        ...Array.from({ length: counts[0] ?? 0 }, (_, index) =>
            bytes.slice(index * partBytes, (index + 1) * partBytes)
        ),
        '',
    ]);
    expect(Buffer.concat(sent).toString()).toBe(bytes);
    expect(completions).toEqual(
        counts.map((count) => ({
            parts: Array.from({ length: count }, (_, index) => ({
                number: index + 1,
                etag: `"${index + 1}-opaque"`,
            })),
        }))
    );
    expect((await readdir(directory)).toSorted()).toEqual(['0', '1']);
    expect(await readFile(join(directory, '0'), 'utf8')).toBe(bytes);
});

test('stored and skipped files require no source reads or part transfers', async () => {
    const { outcome } = await fixture({
        'stored.txt': 'stored',
        'skipped.txt': 'skip',
    });
    for (const file of outcome.files)
        file.source = async () => {
            throw new Error('Must not read');
        };
    let begun = 0;
    const messages: string[] = [];
    const uploader = new WorkerOutcomeUpload(
        async (path, options) => {
            if (path.endsWith('/files'))
                return ++begun === 1
                    ? { stored: true }
                    : { skipped: { code: 'budget', message: 'Not kept' } };
            expect(options.body).toMatchObject({
                warnings: [
                    { code: 'budget', message: 'Skipped skipped.txt: Not kept' },
                ],
            });
            return {};
        },
        async () => {},
        async () => {
            throw new Error('Must not transfer');
        }
    );
    await uploader.uploadOutcome('run_fake', 'FAKE_TOKEN', outcome, [], (message) =>
        messages.push(message)
    );
    expect(begun).toBe(2);
    expect(messages).toEqual(['Not kept']);
});

test('retries only the failed part and retries begin and completion with the same input', async () => {
    const { outcome } = await fixture({ 'retry.txt': 'abcdef' });
    const calls: string[] = [];
    const waits: number[] = [];
    const steps = new Map<string, number>();
    const request: WorkerOutcomeRequest = async (path, options) => {
        const count = (steps.get(path) ?? 0) + 1;
        steps.set(path, count);
        if (count === 1) throw Object.assign(new Error('Unavailable'), { status: 503 });
        if (path.endsWith('/files'))
            return {
                upload: 'retry',
                part_bytes: 3,
                parts: ['https://storage.example/1', 'https://storage.example/2'],
            };
        if (path.includes('/files/')) {
            expect(options.body).toEqual({
                parts: [
                    { number: 1, etag: 'one' },
                    { number: 2, etag: 'two' },
                ],
            });
            return { path: 'retry.txt', size: 6 };
        }
        return {};
    };
    const uploader = new WorkerOutcomeUpload(
        request,
        async (milliseconds) => {
            waits.push(milliseconds);
        },
        async (url, options) => {
            calls.push(url);
            expect(await new Response(options.body).text()).toBe(
                url.endsWith('/1') ? 'abc' : 'def'
            );
            if (url.endsWith('/2') && calls.length === 2)
                return new Response(null, { status: 503 });
            return new Response(null, {
                headers: { ETag: url.endsWith('/1') ? 'one' : 'two' },
            });
        }
    );
    await uploader.uploadOutcome('run_fake', 'FAKE_TOKEN', outcome, [], () => {});
    expect(calls).toEqual([
        'https://storage.example/1',
        'https://storage.example/2',
        'https://storage.example/2',
    ]);
    expect(waits).toEqual([100, 100, 100, 100]);
});

test('exhausted part retries warn and move to the next file, redacting errors and paths', async () => {
    const secret = 'FAKE_SECRET';
    const { outcome } = await fixture({ [`${secret}.txt`]: 'bad', 'next.txt': 'next' });
    let attempts = 0;
    let begun = 0;
    let waits = 0;
    const messages: string[] = [];
    const uploader = new WorkerOutcomeUpload(
        async (path, options) => {
            if (path.endsWith('/files'))
                return ++begun === 1
                    ? {
                          upload: 'bad',
                          part_bytes: 3,
                          parts: ['https://storage.example/bad'],
                      }
                    : { stored: true };
            expect(path).toBe('/v1/runs/run_fake/outcome/complete');
            expect(JSON.stringify(options.body)).not.toContain(secret);
            expect(options.body).toMatchObject({
                warnings: [
                    {
                        code: 'outcome_upload_failed',
                        message: 'Could not upload [redacted]*.txt: [redacted]*',
                    },
                ],
            });
            return {};
        },
        async () => {
            waits += 1;
        },
        async () => {
            attempts += 1;
            throw new Error(secret);
        }
    );
    await uploader.uploadOutcome(
        'run_fake',
        'FAKE_TOKEN',
        outcome,
        [secret],
        (message) => messages.push(message)
    );
    expect(attempts).toBe(3);
    expect(waits).toBe(2);
    expect(begun).toBe(2);
    expect(messages).toEqual(['[redacted]*']);
});

test('completion can skip a file and missing ETags fail the file', async () => {
    const { outcome } = await fixture({ 'skip.txt': 'x', 'bad.txt': 'x' });
    let begun = 0;
    const uploader = new WorkerOutcomeUpload(
        async (path, options) => {
            if (path.endsWith('/files'))
                return {
                    upload: String(++begun),
                    part_bytes: 1,
                    parts: [`https://storage.example/${begun}`],
                };
            if (path.includes('/files/'))
                return { skipped: { code: 'budget', message: 'Full' } };
            expect(options.body).toMatchObject({
                warnings: [{ code: 'budget' }, { code: 'outcome_upload_failed' }],
            });
            return {};
        },
        async () => {},
        async () =>
            new Response(null, { headers: begun === 1 ? { ETag: 'opaque' } : {} })
    );
    await uploader.uploadOutcome('run_fake', 'FAKE_TOKEN', outcome, [], () => {});
});

test('retries interrupted response bodies and network failures without changing the manifest', async () => {
    const { outcome } = await fixture({});
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
        const { outcome } = await fixture({});
        let attempts = 0;
        const api = new WorkerApi('http://localhost', async () => {
            attempts += 1;
            return Response.json(
                { code: 'fake_error', message: 'Fake server explanation' },
                { status }
            );
        });
        await expect(
            new WorkerOutcomeUpload(
                api.request.bind(api),
                async () => {}
            ).uploadOutcome('run_fake', 'FAKE_TOKEN', outcome, [], () => {})
        ).rejects.toThrow('Fake server explanation');
        expect(attempts).toBe(1);
    });
}
