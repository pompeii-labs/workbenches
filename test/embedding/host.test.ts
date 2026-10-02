import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ModelRouter } from '../../src/models/index.js';
import { MemoryOutcomeSink } from '../../src/outcomes/memory.js';
import { RunnerContextStaging } from '../../src/runners/context/stage.js';
import { MemoryRunnerFiles } from '../../src/runners/files/memory.js';
import { OpenCodeRunner } from '../../src/runners/opencode/runner.js';
import type { OpenCodeServerSession } from '../../src/runners/opencode/session.js';
import { OpenCodeSkillStaging } from '../../src/runners/opencode/skills.js';
import type { RunnerSessionHost } from '../../src/runners/session.js';
import type { WorkbenchEventDraft } from '../../src/runs/index.js';
import { DaytonaRuntimeProvider } from '../../src/runtimes/daytona/provider.js';
import type { RemoteCommandOptions } from '../../src/runtimes/remote/process.js';
import { MemoryTransfer } from '../../src/runtimes/staging/memory/transfer.js';
import { TransferRules } from '../../src/runtimes/staging/rules.js';
import { TarArchive } from '../../src/runtimes/staging/tar.js';
import type { ResolvedWorkbench } from '../../src/types.js';
import { modelCatalogFixture } from '../model-catalog-fixture.js';
import {
    connection,
    FakeClient,
    FakeClock,
    FakeSandbox,
} from '../runtimes/daytona/fixture.js';

/**
 * A host with only `fetch`: no filesystem, no key store, no model cache. It
 * prepares a Daytona runtime from bytes it holds, launches the OpenCode runner,
 * drives a session, loses its process, reconnects, resumes the turn it missed,
 * collects the outcome into its own storage, and cleans up. Any write to the
 * local disk fails the test.
 */

const workbench: ResolvedWorkbench = {
    manifestPath: '/pkg/workbench.yml',
    packageDirectory: '/pkg',
    repositoryDirectory: '/ws',
    instructionsPath: '/pkg/instructions.md',
    skills: [
        {
            name: 'review',
            directory: '/pkg/skills/review',
            manifestPath: '/pkg/skills/review/SKILL.md',
        },
    ],
    manifest: {
        spec: 1,
        version: '0.1.0',
        name: 'embedded',
        runner: 'opencode',
        model: { id: 'openai/gpt-5.6-terra' },
        instructions: './instructions.md',
        skills: ['./skills/review'],
        tools: [],
        mcps: [],
        env: {},
        runtimes: {
            daytona: { class: 'linux', image: 'ghcr.io/example/workbench:1.0.0' },
        },
    },
};

/** One in-memory store serves as the runner's files and the runtime's assets. */
function storage(): MemoryRunnerFiles {
    return new MemoryRunnerFiles()
        .file('/pkg/workbench.yml', 'name: embedded')
        .file('/pkg/instructions.md', 'Be precise.')
        .file('/pkg/skills/review/SKILL.md', 'Review carefully.')
        .file('/ws/notes.txt', 'original\n');
}

// The host's working directory and temporary directory both point at an empty
// directory made for this file. Anything the host wrote to disk, by a relative
// path or into the temporary directory, would show up in it.
let scratch = '';
let workingDirectory = '';
let temporaryDirectory: string | undefined;

beforeAll(async () => {
    workingDirectory = process.cwd();
    temporaryDirectory = process.env.TMPDIR;
    scratch = await mkdtemp(join(tmpdir(), 'embedding-host-'));
    process.chdir(scratch);
    process.env.TMPDIR = scratch;
});

afterAll(async () => {
    process.chdir(workingDirectory);
    if (temporaryDirectory === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = temporaryDirectory;
    await rm(scratch, { recursive: true, force: true });
});

describe('a host with only fetch', () => {
    test('prepares, drives, reconnects, resumes, collects, and cleans up without touching disk', async () => {
        const files = storage();
        const sandbox = new EmbeddedSandbox();
        sandbox.holdProcesses = true;
        const client = new EmbeddedClient(sandbox);
        const opencode = new FakeOpenCode();
        const configuration = new ModelRouter(modelCatalogFixture).resolve({
            workbench,
        });
        const provider = new DaytonaRuntimeProvider({
            transfer: new MemoryTransfer(files, new TransferRules('Daytona')),
            assets: files,
            clock: new FakeClock(),
            ...connection(client),
        });
        const makeRunner = () =>
            new OpenCodeRunner({
                skills: new OpenCodeSkillStaging(
                    files,
                    new RunnerContextStaging(files)
                ),
                catalog: modelCatalogFixture,
                session: {
                    fetch: (input, init) => opencode.fetch(input, init),
                    // The host keeps the password, so a later process can reuse it.
                    password: () => 'kept-password',
                },
            });
        const request = (staged: string) => ({
            workbench,
            workspaceDirectory: '/ws',
            environment: { OPENAI_API_KEY: 'key' },
            assets: [
                { path: '/ws', access: 'read-write' as const },
                { path: '/pkg', access: 'read-only' as const },
                { path: staged, access: 'read-write' as const },
            ],
        });

        // First process: prepare, launch, drive. The host saves progress as it goes.
        const runner = makeRunner();
        const prepared = await runner.prepare(workbench);
        const staged = prepared.assets[0]?.path ?? '';
        const runtime = await provider.prepare(request(staged));
        await runtime.preflight();
        const sandboxId = runtime.sandboxId;
        expect(sandboxId).toBe('sandbox-fixture');
        expect(sandbox.uploads.size).toBe(3);

        let saved: unknown;
        const firstEvents: WorkbenchEventDraft[] = [];
        const first = (await prepared.startSession(runtime, {
            configuration,
            host: host(firstEvents, () => {
                // Progress counts text once the host has stored it, so when the
                // second piece arrives it says five characters. The host keeps
                // that value and goes away before it stores the second piece.
                if (saved === undefined && outputText(firstEvents) === 'Hello world') {
                    saved = JSON.parse(JSON.stringify(first.progress()));
                }
            }),
        })) as OpenCodeServerSession;
        expect(sandbox.started).toHaveLength(1);
        await expect(first.prompt('Summarize notes.txt')).resolves.toEqual({
            reason: 'stop',
        });
        expect(outputText(firstEvents)).toBe('Hello world');
        const nativeSession = first.id;
        expect(nativeSession).toBe('ses_1');
        expect(saved).toMatchObject({ text: { part_1: 5 } });

        // The first process is gone. Its server keeps running in the sandbox.
        sandbox.listening = true;

        // Second process: reconnect with only the sandbox id and the session id.
        const restarted = makeRunner();
        const preparedAgain = await restarted.prepare(workbench);
        const adopted = await provider.adopt(
            request(preparedAgain.assets[0]?.path ?? ''),
            sandboxId ?? ''
        );
        await adopted.preflight();
        expect(sandbox.uploads.size).toBe(3);
        const secondEvents: WorkbenchEventDraft[] = [];
        const second = (await preparedAgain.startSession(adopted, {
            configuration,
            host: host(secondEvents),
            session: {
                id: 'embedded-session',
                directory: '/sessions/embedded',
                ...(nativeSession ? { nativeSessionId: nativeSession } : {}),
            },
        })) as OpenCodeServerSession;
        // It attached to the running server instead of starting another.
        expect(sandbox.started).toHaveLength(1);
        expect(opencode.passwordsSeen).toEqual(new Set(['kept-password']));

        // Resume the turn the host only partly saw: it emits what it had not seen.
        second.restoreProgress(saved as Parameters<typeof second.restoreProgress>[0]);
        await expect(second.resumeTurn()).resolves.toEqual({ reason: 'stop' });
        expect(outputText(secondEvents)).toBe(' world');
        expect(
            secondEvents.filter((event) => event.type === 'usage.updated')
        ).toHaveLength(1);

        // And keep working in the same session.
        await expect(second.prompt('Now edit it.')).resolves.toEqual({
            reason: 'stop',
        });
        expect(opencode.prompts).toEqual(['Summarize notes.txt', 'Now edit it.']);

        // Collect what the sandbox changed into the host's own storage.
        sandbox.output = await TarArchive.pack([
            {
                name: 'notes.txt',
                type: 'file',
                mode: 0o644,
                content: text('edited\n'),
            },
        ]).gzip();
        const sink = new MemoryOutcomeSink();
        const outcome = await adopted.collectOutcome?.(sink);
        expect(outcome?.changesets[0]?.entries).toMatchObject([
            { path: 'notes.txt', operation: 'modify' },
        ]);
        const after = outcome?.changesets[0]?.entries[0]?.after;
        expect(after?.kind === 'file' && sink.get(after.content)).toEqual(
            text('edited\n')
        );

        await second.close();
        await first.close();
        await adopted.cleanup();
        await preparedAgain.cleanup();
        await prepared.cleanup();
        expect(client.deleted).toEqual(['sandbox-fixture']);
        // Staged skills were cleaned out of the store.
        expect(
            files.paths().filter((path) => path.includes('workbench-opencode-'))
        ).toEqual([]);
        // The host's stores hold what they should: the collected change went to
        // the sink, and the workspace and package in memory are as they were.
        expect(files.text('/ws/notes.txt')).toBe('original\n');
        expect(files.text('/pkg/instructions.md')).toBe('Be precise.');
        expect(sink.digests().length).toBeGreaterThan(0);
        // Nothing reached the local disk, by a relative path or the temporary directory.
        expect(process.cwd()).toBe(await realpath(scratch));
        expect(await readdir(scratch)).toEqual([]);
    });
});

const text = (value: string) => new TextEncoder().encode(value);

function host(events: WorkbenchEventDraft[], onEvent?: () => void): RunnerSessionHost {
    return {
        emit: async (event) => {
            events.push(event);
            onEvent?.();
        },
        requestPermission: async () => 'reject',
        requestQuestion: async () => ({ outcome: 'rejected' }),
    };
}

function outputText(events: WorkbenchEventDraft[]): string {
    return events
        .filter((event) => event.type === 'output.text')
        .map((event) => String(event.data.text))
        .join('');
}

/** The Daytona client's fake, which also reports a sandbox the host reconnects to. */
class EmbeddedClient extends FakeClient {
    constructor(private readonly embedded: EmbeddedSandbox) {
        super();
    }

    override async createSandbox() {
        return this.embedded;
    }

    override async getSandbox() {
        return this.embedded;
    }
}

/** A sandbox whose runner server reports its address and whose output the test sets. */
class EmbeddedSandbox extends FakeSandbox {
    /** The archive the run left behind at the first workspace output path. */
    output: Uint8Array | undefined;

    override async start(command: string, options: RemoteCommandOptions = {}) {
        const { onStdout, ...rest } = options;
        const process = await super.start(command, rest);
        await onStdout?.('opencode server listening on http://0.0.0.0:4096\n');
        return process;
    }

    override async fileSize(path: string): Promise<number> {
        return path === '/tmp/workbench-output-0.tar.gz' && this.output
            ? this.output.byteLength
            : super.fileSize(path);
    }

    override async download(path: string): Promise<ReadableStream<Uint8Array>> {
        return path === '/tmp/workbench-output-0.tar.gz' && this.output
            ? new Blob([this.output as Uint8Array<ArrayBuffer>]).stream()
            : super.download(path);
    }
}

/** The runner's server in the sandbox, reached over the preview URL with `fetch`. */
class FakeOpenCode {
    readonly prompts: string[] = [];
    readonly passwordsSeen = new Set<string>();
    private transcript: Array<{ info: Record<string, unknown>; parts: unknown[] }> = [];
    private controller: ReadableStreamDefaultController<Uint8Array> | undefined;

    async fetch(
        input: string | URL | Request,
        init: RequestInit = {}
    ): Promise<Response> {
        const url = new URL(String(input));
        expect(url.host).toBe('4096-token.proxy.daytona.test');
        const authorization = new Headers(init.headers).get('Authorization') ?? '';
        this.passwordsSeen.add(
            atob(authorization.replace('Basic ', '')).split(':')[1] ?? ''
        );
        if (url.pathname === '/session' && init.method === 'POST') {
            return Response.json({ id: 'ses_1' });
        }
        if (url.pathname === '/session/ses_1' && init.method === 'GET') {
            return Response.json({ id: 'ses_1' });
        }
        if (url.pathname === '/session/ses_1/message') {
            return Response.json(this.transcript);
        }
        if (url.pathname === '/event') {
            const stream = new ReadableStream<Uint8Array>({
                start: (controller) => {
                    this.controller = controller;
                    init.signal?.addEventListener('abort', () => {
                        try {
                            controller.close();
                        } catch {}
                    });
                },
            });
            return new Response(stream);
        }
        if (url.pathname === '/session/ses_1/prompt_async') {
            const body = JSON.parse(String(init.body)) as {
                messageID: string;
                parts: Array<{ text?: string }>;
            };
            // A resumed session puts a refreshed runtime reminder before the input.
            this.prompts.push(body.parts.at(-1)?.text ?? '');
            queueMicrotask(() => this.answer(body.messageID));
            return new Response(null, { status: 204 });
        }
        return new Response(null, { status: 404 });
    }

    private answer(inputId: string) {
        const n = this.prompts.length;
        const messageId = `message_${n}`;
        const partId = `part_${n}`;
        const emit = (type: string, properties: Record<string, unknown>) =>
            this.controller?.enqueue(
                new TextEncoder().encode(
                    `data: ${JSON.stringify({ type, properties: { sessionID: 'ses_1', ...properties } })}\n\n`
                )
            );
        emit('session.status', { status: { type: 'busy' } });
        emit('message.updated', {
            info: { id: messageId, role: 'assistant', parentID: inputId },
        });
        emit('message.part.updated', {
            part: { id: partId, messageID: messageId, type: 'text', text: '' },
        });
        const reply = n === 1 ? 'Hello world' : 'Edited';
        for (const delta of n === 1 ? ['Hello', ' world'] : ['Edited']) {
            emit('message.part.delta', {
                messageID: messageId,
                partID: partId,
                field: 'text',
                delta,
            });
        }
        const finish = {
            id: `finish_${n}`,
            messageID: messageId,
            type: 'step-finish',
            reason: 'stop',
            tokens: { total: 10 },
        };
        emit('message.part.updated', { part: finish });
        emit('session.status', { status: { type: 'idle' } });
        this.transcript = [
            ...this.transcript,
            { info: { id: inputId, role: 'user' }, parts: [] },
            {
                info: {
                    id: messageId,
                    role: 'assistant',
                    parentID: inputId,
                    finish: 'stop',
                    time: { created: 1, completed: 2 },
                },
                parts: [
                    { id: partId, messageID: messageId, type: 'text', text: reply },
                    finish,
                ],
            },
        ];
    }
}
