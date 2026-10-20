import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
    PreparedRuntime,
    RuntimePrepareRequest,
    RuntimePreview,
} from '../../../src/runtimes/contracts.js';
import { SandboxPreviews } from '../../../src/runtimes/daytona/previews.js';
import { RuntimeRegistry } from '../../../src/runtimes/index.js';
import { TarArchive } from '../../../src/runtimes/staging/tar.js';
import {
    cleanTemporaryDirectories,
    daytonaProvider,
    FakeClient,
    fixture,
    request,
    track,
} from './fixture.js';

afterEach(cleanTemporaryDirectories);

const helper = '/opt/workbench/bin/wbx';
const control = '/opt/workbench/previews/announcements.jsonl';
const encode = (text: string) => new TextEncoder().encode(text);
const line = (name: string, port: number) => `${JSON.stringify({ name, port })}\n`;

async function outbox(): Promise<string> {
    return track(await mkdtemp(join(tmpdir(), 'workbench-daytona-previews-')));
}

/** A prepared and checked runtime whose run has an outbox, with a listener attached. */
async function running(
    client = new FakeClient(),
    extra: Partial<RuntimePrepareRequest> = {}
) {
    const runtime = await RuntimeRegistry.standard({
        daytona: {
            connector: { open: () => client },
            keys: { key: () => 'fixture-key' },
        },
    })
        .resolve('daytona')
        .prepare({
            ...request(await fixture()),
            outcome: { directory: await outbox() },
            ...extra,
        } as RuntimePrepareRequest);
    await runtime.preflight();
    const published: RuntimePreview[] = [];
    const warnings: string[] = [];
    runtime.previews?.watch({
        available: async (preview) => {
            published.push(preview);
        },
        warn: (message) => warnings.push(message),
    });
    await Bun.sleep(0);
    const announce = async (text: string) => {
        const previous = client.sandbox.files.get(control) ?? new Uint8Array();
        const next = new Uint8Array([...previous, ...encode(text)]);
        client.sandbox.files.set(control, next);
        // The control session replays the file from its start, as tail -n +1 does.
        client.sandbox.follows[0]?.output(next, 0);
    };
    return { runtime, client, published, warnings, announce };
}

function service(runtime: PreparedRuntime) {
    return runtime.launchService((binding) => ({
        command: ['opencode', 'serve', binding.hostname, String(binding.port)],
        cwd: runtime.workspaceDirectory,
        env: {},
    }));
}

describe('Daytona previews', () => {
    test('stages wbx outside the outbox and puts it first on the runner PATH', async () => {
        const { runtime, client } = await running();
        try {
            const script = new TextDecoder().decode(client.sandbox.uploads.get(helper));
            expect(script).toStartWith('#!/bin/sh\n');
            expect(script).toContain(`control='${control}'`);
            expect(control.startsWith('/outbox')).toBeFalse();
            expect(
                client.sandbox.runs.some(
                    (run) =>
                        run.command.includes(`chmod 700 '${helper}'`) &&
                        run.command.includes(`chmod 600 '${control}'`)
                )
            ).toBeTrue();
            service(runtime);
            const launched = client.sandbox.started.at(-1);
            // PATH is a command prefix, because the toolbox quotes environment values.
            expect(launched?.command).toStartWith(
                `PATH='/opt/workbench/bin':"$PATH" 'opencode' 'serve'`
            );
            expect(launched?.options.env?.PATH).toBeUndefined();
            runtime.launchSession(
                {
                    command: ['opencode', 'run'],
                    cwd: runtime.workspaceDirectory,
                    env: {},
                },
                { stdin: 'ignore' }
            );
            expect(client.sandbox.started.at(-1)?.command).toStartWith(
                `PATH='/opt/workbench/bin':"$PATH" 'opencode' 'run'`
            );
            expect(client.sandbox.follows.map((follow) => follow.command)).toEqual([
                `exec tail -n +1 -F '${control}'`,
            ]);
        } finally {
            await runtime.cleanup();
        }
    });

    test('a run without an outbox gets no helper, no PATH change, and no control session', async () => {
        const client = new FakeClient();
        const runtime = await daytonaProvider({ client }).prepare(
            request(await fixture())
        );
        try {
            await runtime.preflight();
            expect(runtime.previews).toBeUndefined();
            expect(client.sandbox.uploads.has(helper)).toBeFalse();
            service(runtime);
            expect(client.sandbox.started.at(-1)?.command).toStartWith(`'opencode'`);
            await expect(runtime.previewUrl?.(5173, 60)).rejects.toThrow(
                'The Daytona sandbox is not running with previews'
            );
            await expect(runtime.linger?.(30)).rejects.toThrow(
                'The run announced no preview'
            );
        } finally {
            await runtime.cleanup();
        }
        expect(client.deleted).toEqual(['sandbox-fixture']);
        expect(client.lifecycle).toEqual([]);
    });

    test('publishes followed announcements once and refresh only adds what was missed', async () => {
        const { runtime, client, published, announce } = await running();
        try {
            client.sandbox.listeningPorts.add(5173);
            client.sandbox.listeningPorts.add(8080);
            await announce(line('demo', 5173));
            await announce(line('game', 8080));
            await runtime.previews?.refresh();
            expect(published).toEqual([
                { name: 'demo', port: 5173 },
                { name: 'game', port: 8080 },
            ]);
            // An announcement the follower missed arrives with the turn-end read.
            const missed = encode(line('docs', 8080));
            client.sandbox.files.set(
                control,
                new Uint8Array([
                    ...(client.sandbox.files.get(control) ?? []),
                    ...missed,
                ])
            );
            await runtime.previews?.refresh();
            await runtime.previews?.close();
            await announce(line('late', 5173));
            await runtime.previews?.refresh();
            expect(published.map((preview) => preview.name)).toEqual([
                'demo',
                'game',
                'docs',
            ]);
            expect(client.sandbox.follows[0]?.stopped).toBeTrue();
        } finally {
            await runtime.cleanup();
        }
    });

    test("reserves the runner's server and Daytona's toolbox ports", async () => {
        const { runtime, client, published, warnings, announce } = await running();
        try {
            expect(runtime.reservedPorts?.()).toEqual([4096, 2280, 22222, 33333]);
            for (const port of [4096, 2280, 22222, 33333]) {
                client.sandbox.listeningPorts.add(port);
                await announce(line(`port-${port}`, port));
            }
            await runtime.previews?.refresh();
            expect(published).toEqual([]);
            expect(warnings).toEqual(
                [4096, 2280, 22222, 33333].map(
                    (port) =>
                        `Ignored a preview announcement: port ${port} of port-${port} is reserved by the engine`
                )
            );
        } finally {
            await runtime.cleanup();
        }
    });

    test('checks the port inside the sandbox before accepting it', async () => {
        const { runtime, published, warnings, announce } = await running();
        try {
            await announce(line('demo', 5173));
            await runtime.previews?.refresh();
            expect(published).toEqual([]);
            expect(warnings).toEqual([
                'Ignored preview demo: nothing is listening on port 5173',
            ]);
        } finally {
            await runtime.cleanup();
        }
    });

    describe('signed preview URLs', () => {
        test('mints a new URL on every call for an announced port only', async () => {
            const { runtime, client, published, warnings, announce } = await running();
            try {
                client.sandbox.listeningPorts.add(5173);
                await announce(line('demo', 5173));
                await runtime.previews?.refresh();
                const first = await runtime.previewUrl?.(5173, 600);
                const second = await runtime.previewUrl?.(5173, 600);
                expect(first?.url).not.toBe(second?.url);
                expect(client.sandbox.signed).toEqual([
                    { port: 5173, ttlSeconds: 600 },
                    { port: 5173, ttlSeconds: 600 },
                ]);
                await runtime.expireSignedPreviewUrl?.(5173, first?.token ?? '');
                expect(client.sandbox.expired).toEqual([
                    { port: 5173, token: 'signed-token-1' },
                ]);
                for (const port of [8080, 4096, 2280]) {
                    await expect(runtime.previewUrl?.(port, 600)).rejects.toThrow(
                        `Port ${port} is not a preview this run announced`
                    );
                    await expect(
                        runtime.expireSignedPreviewUrl?.(port, 'signed-token-1')
                    ).rejects.toThrow(
                        `Port ${port} is not a preview this run announced`
                    );
                }
                for (const ttl of [0, -1, 1.5, 86_401]) {
                    await expect(runtime.previewUrl?.(5173, ttl)).rejects.toThrow(
                        'A signed preview URL must expire after a whole number of seconds from 1 to 86400'
                    );
                }
                // Only the caller ever sees a signed URL or its token.
                const observed = JSON.stringify({ published, warnings });
                expect(observed).not.toContain('signed-token');
                expect(observed).not.toContain('proxy.daytona.test');
            } finally {
                await runtime.cleanup();
            }
            await expect(runtime.previewUrl?.(5173, 600)).rejects.toThrow(
                'The Daytona sandbox is not running with previews'
            );
        });
    });

    describe('linger', () => {
        async function announced(client = new FakeClient(), credentials?: string) {
            // Cleanup copies the credential store out, so it needs an archive to read.
            client.sandbox.nativeStateDownload = await new TarArchive(
                TarArchive.pack([]).bytes
            ).gzip();
            const started = await running(
                client,
                credentials
                    ? {
                          credentials: {
                              runtime: 'daytona',
                              runner: 'opencode',
                              directory: credentials,
                          },
                      }
                    : {}
            );
            client.sandbox.listeningPorts.add(5173);
            await started.announce(line('demo', 5173));
            await started.runtime.previews?.close();
            return started;
        }

        test('removes credential files, keeps the sandbox running, and sets its TTL', async () => {
            const credentials = await outbox();
            const { runtime, client } = await announced(new FakeClient(), credentials);
            client.sandbox.holdProcesses = true;
            service(runtime);
            await runtime.linger?.(30);
            expect(client.sandbox.runs.map((run) => run.command)).toContain(
                "rm -rf -- '/workbench-credentials' && test ! -e '/workbench-credentials'"
            );
            expect(client.sandbox.killedProcesses).toBeGreaterThan(0);
            expect(client.deleted).toEqual([]);
            expect(client.lifecycle).toEqual(['ttl 30 sandbox-fixture']);
            // A lingering sandbox still serves the run's previews.
            await expect(runtime.previewUrl?.(5173, 600)).resolves.toMatchObject({
                token: 'signed-token-1',
            });
            await runtime.linger?.(45);
            expect(client.lifecycle).toEqual([
                'ttl 30 sandbox-fixture',
                'ttl 45 sandbox-fixture',
            ]);
            await runtime.cleanup();
            expect(client.deleted).toEqual(['sandbox-fixture']);
            await expect(runtime.previewUrl?.(5173, 600)).rejects.toThrow(
                'not running with previews'
            );
            await runtime.cleanup();
            expect(client.deleted).toEqual(['sandbox-fixture']);
        });

        test('a lingering sandbox can be suspended instead of deleted', async () => {
            const { runtime, client } = await announced();
            await runtime.linger?.(30);
            await runtime.suspend?.(60);
            expect(client.lifecycle).toEqual([
                'ttl 30 sandbox-fixture',
                'stop sandbox-fixture',
                'autoarchive 61 sandbox-fixture',
                'autodelete 60 sandbox-fixture',
                'ttl 0 sandbox-fixture',
            ]);
            await runtime.cleanup();
            expect(client.deleted).toEqual([]);
        });

        test('deletes the sandbox when its credential files cannot be removed', async () => {
            const credentials = await outbox();
            const client = new FakeClient();
            const { runtime } = await announced(client, credentials);
            const run = client.sandbox.run.bind(client.sandbox);
            client.sandbox.run = async (command, options) =>
                command.startsWith('rm -rf --')
                    ? { code: 1, stdout: '', stderr: '' }
                    : run(command, options);
            await expect(runtime.linger?.(30)).rejects.toThrow(
                'The credential files in Daytona sandbox sandbox-fixture could not be removed, so the sandbox was deleted instead of kept running'
            );
            expect(client.deleted).toEqual(['sandbox-fixture']);
            expect(client.lifecycle).toEqual([]);
        });

        test('refuses a run without previews and a time that is not whole minutes', async () => {
            const { runtime, client } = await running();
            try {
                await expect(runtime.linger?.(30)).rejects.toThrow(
                    'The run announced no preview, so there is nothing to keep the sandbox running for'
                );
                for (const minutes of [0, -1, 1.5]) {
                    await expect(runtime.linger?.(minutes)).rejects.toThrow(
                        'A lingering Daytona sandbox must be kept for a whole number of minutes'
                    );
                }
            } finally {
                await runtime.cleanup();
            }
            expect(client.deleted).toEqual(['sandbox-fixture']);
            expect(client.lifecycle).toEqual([]);
        });

        test('a run with previews that ends with cleanup is deleted as before', async () => {
            const { runtime, client } = await announced();
            await runtime.cleanup();
            expect(client.deleted).toEqual(['sandbox-fixture']);
            expect(client.lifecycle).toEqual([]);
            expect(client.sandbox.follows[0]?.stopped).toBeTrue();
        });
    });

    test('the helper and control file live where the runtime says', () => {
        expect(SandboxPreviews.helperDirectory).toBe('/opt/workbench/bin');
        expect(SandboxPreviews.controlFile).toBe(control);
    });
});
