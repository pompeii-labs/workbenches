import { describe, expect, test } from 'bun:test';

import {
    type ModelCatalogSnapshot,
    ModelRouter,
    routeConfiguration,
} from '../src/models/index.js';
import { MemoryOutcomeStore } from '../src/outcomes/index.js';
import { MemoryRunnerFiles } from '../src/runners/files-memory.js';
import { OpenCodeRunner } from '../src/runners/opencode/runner.js';
import type { OpenCodeServerSession } from '../src/runners/opencode/session.js';
import type { RunnerSessionHost } from '../src/runners/session.js';
import type { WorkbenchEventDraft } from '../src/runs/index.js';
import type {
    DaytonaClient,
    DaytonaProcess,
    DaytonaProcessOptions,
    DaytonaSandbox,
    DaytonaSandboxInfo,
} from '../src/runtimes/daytona/contracts.js';
import { DaytonaRuntimeProvider } from '../src/runtimes/daytona/provider.js';
import { e2bIdentityCommand } from '../src/runtimes/e2b/directories.js';
import { packTarGzip } from '../src/runtimes/staging/tar.js';
import type { ResolvedWorkbench } from '../src/types.js';

/**
 * A host with only `fetch`: no filesystem, no key store, no model cache. It
 * prepares a Daytona runtime from bytes it holds, launches the OpenCode runner,
 * drives a session, loses its process, reconnects, collects the outcome into its
 * own storage, and cleans up. Nothing here touches disk.
 */

const catalog: ModelCatalogSnapshot = {
    version: 'embedding',
    models: {
        'openai/gpt-fixture': {
            routes: { openai: 'gpt-fixture', openrouter: 'openai/gpt-fixture' },
        },
    },
    providers: {
        openai: { env: ['OPENAI_API_KEY'] },
        openrouter: { env: ['OPENROUTER_API_KEY'] },
    },
};

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
        model: { id: 'openai/gpt-fixture' },
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

describe('a host with only fetch', () => {
    test('prepares, drives, reconnects, collects, and cleans up without touching disk', async () => {
        const files = storage();
        const sandbox = new FakeSandbox();
        const client = new FakeClient(sandbox);
        const opencode = new FakeOpenCode();
        const configuration = routeConfiguration({
            catalog,
            model: workbench.manifest.model,
            environmentNames: ['OPENAI_API_KEY'],
        });
        expect(configuration.model).toBe('openai/gpt-fixture');
        const provider = new DaytonaRuntimeProvider({
            client,
            assets: files,
            providerEnvironment: (value) =>
                new ModelRouter(catalog).providerEnvironmentNames(value),
        });
        const makeRunner = () =>
            new OpenCodeRunner({
                files,
                catalog,
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

        // First process: prepare, launch, drive.
        const runner = makeRunner();
        const prepared = await runner.prepare(workbench);
        const staged = prepared.assets[0]?.path ?? '';
        const runtime = await provider.prepare(request(staged));
        await runtime.preflight();
        const sandboxId = runtime.sandboxId;
        expect(sandboxId).toBe('sandbox-embedded');
        expect(sandbox.uploads.size).toBe(3);

        const firstEvents: WorkbenchEventDraft[] = [];
        const first = (await prepared.startSession(runtime, {
            configuration,
            host: host(firstEvents),
        })) as OpenCodeServerSession;
        expect(sandbox.started).toHaveLength(1);
        await expect(first.prompt('Summarize notes.txt')).resolves.toEqual({
            reason: 'stop',
        });
        expect(outputText(firstEvents)).toBe('Hello world');
        const nativeSession = first.id;
        expect(nativeSession).toBe('ses_1');

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

        // Catch up on the turn that finished while the host was away.
        await expect(second.resumeTurn()).resolves.toEqual({ reason: 'stop' });
        expect(outputText(secondEvents)).toBe('Hello world');
        expect(
            secondEvents.filter((event) => event.type === 'usage.updated')
        ).toHaveLength(1);

        // And keep working in the same session.
        await expect(second.prompt('Now edit it.')).resolves.toEqual({
            reason: 'stop',
        });
        expect(opencode.prompts).toEqual(['Summarize notes.txt', 'Now edit it.']);

        // Collect what the sandbox changed into the host's own storage.
        sandbox.remote.set(
            '/tmp/workbench-output-0.tar.gz',
            await packTarGzip([
                {
                    name: 'notes.txt',
                    type: 'file',
                    mode: 0o644,
                    content: text('edited\n'),
                },
            ])
        );
        const store = new MemoryOutcomeStore();
        const outcome = await adopted.collectOutcome?.(store);
        expect(outcome?.changesets[0]?.entries).toMatchObject([
            { path: 'notes.txt', operation: 'modify' },
        ]);
        const after = outcome?.changesets[0]?.entries[0]?.after;
        expect(after?.kind === 'file' && store.get(after.content)).toEqual(
            text('edited\n')
        );

        await second.close();
        await first.close();
        await adopted.cleanup();
        await preparedAgain.cleanup();
        await prepared.cleanup();
        expect(client.deleted).toEqual(['sandbox-embedded']);
        // Staged skills were cleaned out of the store.
        expect(
            files.paths().filter((path) => path.includes('workbench-opencode-'))
        ).toEqual([]);
    });
});

const text = (value: string) => new TextEncoder().encode(value);

function host(events: WorkbenchEventDraft[]): RunnerSessionHost {
    return {
        emit: async (event) => void events.push(event),
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

class FakeClient implements DaytonaClient {
    readonly deleted: string[] = [];

    constructor(private readonly sandbox: FakeSandbox) {}

    async createSandbox(): Promise<DaytonaSandbox> {
        return this.sandbox;
    }

    async listSandboxes() {
        return [];
    }

    async getSandbox() {
        return this.sandbox;
    }

    async deleteSandbox(id: string): Promise<void> {
        this.deleted.push(id);
    }
}

class FakeSandbox implements DaytonaSandbox {
    readonly id = 'sandbox-embedded';
    listening = false;
    readonly started: string[] = [];
    readonly uploads = new Map<string, Uint8Array>();
    readonly remote = new Map<string, Uint8Array>();

    async run(command: string) {
        if (command === e2bIdentityCommand) return result(0, '1000:1000');
        if (command === 'tar --help 2>&1') return result(0, '--null');
        if (command.startsWith('command -v')) {
            const name = command.match(/'([^']+)'/)?.[1] ?? 'tool';
            return result(0, `/usr/bin/${name}\n`);
        }
        if (command.includes('rev-parse HEAD')) return result(0, `${'a'.repeat(40)}\n`);
        if (command.includes('rev-list --max-parents=0')) {
            return result(0, `${'a'.repeat(40)}\n`);
        }
        if (command.includes('/dev/tcp/')) return result(this.listening ? 0 : 1);
        if (command.startsWith('wc -c <')) {
            const path = command.match(/'([^']+)'/)?.[1] ?? '';
            return result(
                0,
                `${(this.remote.get(path) ?? new Uint8Array()).byteLength}\n`
            );
        }
        return result(0);
    }

    async start(command: string, options: DaytonaProcessOptions = {}) {
        this.started.push(command);
        await options.onStdout?.('opencode server listening on http://0.0.0.0:4096\n');
        let release: (() => void) | undefined;
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });
        const process: DaytonaProcess = {
            wait: async () => {
                await held;
                return result(0);
            },
            sendStdin: async () => {},
            closeStdin: async () => {},
            kill: async () => release?.(),
        };
        return process;
    }

    async upload(path: string, data: Uint8Array): Promise<void> {
        this.uploads.set(path, data);
    }

    async download(path: string): Promise<ReadableStream<Uint8Array>> {
        return new Blob([this.remote.get(path) ?? new Uint8Array()]).stream();
    }

    async previewUrl(port: number): Promise<string> {
        return `https://${port}-token.proxy.daytona.test`;
    }

    async info(): Promise<DaytonaSandboxInfo> {
        return { cpuCount: 1, memoryMB: 1_024, diskGb: 3 };
    }
}

function result(code: number, stdout = '', stderr = '') {
    return { code, stdout, stderr };
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
