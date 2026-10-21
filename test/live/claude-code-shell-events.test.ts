import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelRouter } from '../../src/models/index.js';
import { CLAUDE_CODE_VERSION } from '../../src/runners/claude-code/capabilities.js';
import { ClaudeCodeSessionAdapter } from '../../src/runners/claude-code/session.js';
import type { RunnerSession } from '../../src/runners/session.js';
import type { WorkbenchEventDraft } from '../../src/runs/index.js';
import { modelCatalogFixture } from '../model-catalog-fixture.js';
import { claudeCodeWorkbench } from '../runners/claude-code/fixture.js';

const SECRET = 'MUST_NOT_RENDER_SHELL_SECRET';
const KEY = 'sk-ant-api03-0123456789abcdefABCDEF0123456789abcdef';

// No provider credentials or paid model requests. The real Claude Code binary
// talks only to a loopback Anthropic Messages fixture that asks for one Bash
// call carrying credentials, which Claude Code really runs, then finishes. Its
// secure storage is an empty directory, so no personal login is ever read.
test.skipIf(process.env.WORKBENCH_SHELL_EVENTS_E2E !== '1')(
    'real Claude Code shell calls cross the event boundary without their credentials',
    async () => {
        // A package script's PATH can reach an older claude in a parent node_modules.
        const installed = Bun.spawnSync(['claude', '--version']).stdout.toString();
        const version = /\d+\.\d+\.\d+/u.exec(installed)?.[0] ?? 'none';
        expect(
            Bun.semver.order(
                version === 'none' ? '0.0.0' : version,
                CLAUDE_CODE_VERSION
            ),
            `claude on PATH is ${version}; this test needs ${CLAUDE_CODE_VERSION} or later`
        ).toBeGreaterThanOrEqual(0);
        const root = await mkdtemp(join(tmpdir(), 'wb-claude-shell-events-'));
        const health: string[] = [];
        const provider = Bun.serve({
            hostname: '127.0.0.1',
            port: 0,
            fetch: async (request): Promise<Response> => {
                const url = new URL(request.url);
                if (request.method === 'GET' && url.pathname === '/health') {
                    health.push(request.headers.get('authorization') ?? '');
                    return new Response('healthy');
                }
                if (
                    request.method !== 'POST' ||
                    !url.pathname.endsWith('/v1/messages')
                ) {
                    return Response.json({});
                }
                const body = (await request.json()) as {
                    stream?: boolean;
                    tools?: { name?: string }[];
                    messages?: { content?: unknown }[];
                };
                const answered = JSON.stringify(body.messages ?? []).includes(
                    '"tool_result"'
                );
                const offersBash = body.tools?.some((tool) => tool.name === 'Bash');
                const reply: Block =
                    offersBash && !answered
                        ? toolUse(command(Number(new URL(request.url).port)))
                        : textBlock('done');
                return body.stream ? stream(reply) : Response.json(message(reply));
            },
        });
        let session: RunnerSession | undefined;
        try {
            const workbench = claudeCodeWorkbench(root);
            const staged = join(root, 'staged');
            const config = join(staged, 'config');
            await mkdir(config, { recursive: true });
            await writeFile(
                join(staged, 'mcp.json'),
                JSON.stringify({ mcpServers: {} })
            );
            await writeFile(join(staged, 'system.md'), 'Run the requested command.');
            await writeFile(
                join(staged, 'settings.json'),
                JSON.stringify({ permissions: { allow: ['Bash'] } })
            );
            const events: WorkbenchEventDraft[] = [];
            session = await new ClaudeCodeSessionAdapter({
                prepare: async () => {
                    throw new Error('the test starts a prepared session');
                },
            }).startPrepared(
                {
                    workbench,
                    workspaceDirectory: root,
                    environment: { PATH: process.env.PATH ?? '', HOME: root },
                    configuration: new ModelRouter(modelCatalogFixture).resolve({
                        workbench,
                    }),
                    host: {
                        emit: async (event) => void events.push(event),
                        requestPermission: async () => 'allow_once',
                        requestQuestion: async () => ({ outcome: 'rejected' }),
                    },
                },
                {
                    paths: {
                        configDirectory: config,
                        mcpConfigPath: join(staged, 'mcp.json'),
                        systemPromptPath: join(staged, 'system.md'),
                    },
                    settings: join(staged, 'settings.json'),
                    routeEnvironment: {
                        ANTHROPIC_API_KEY: 'fixture-key',
                        ANTHROPIC_BASE_URL: `http://127.0.0.1:${provider.port}`,
                        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
                    },
                    secureStorageDirectory: config,
                    scrubSubprocessEnvironment: false,
                    answersPrompts: true,
                }
            );
            expect(await session.prompt('Check the service')).toEqual({
                reason: 'end_turn',
            });

            // The command really ran with its credentials.
            expect(health).toEqual([`Bearer ${KEY}`]);
            const shell = events.find(
                (event) => event.type === 'tool.completed' && event.data.name === 'Bash'
            );
            expect(shell?.data).toEqual(
                expect.objectContaining({
                    title: 'Check the service',
                    target: `API_TOKEN=[REDACTED] sh -c 'echo shell-e2e' && curl -s -H "Authorization: [REDACTED]" http://127.0.0.1:${provider.port}/health`,
                    status: 'completed',
                })
            );
            const serialized = JSON.stringify(events);
            expect(serialized).not.toContain(SECRET);
            expect(serialized).not.toContain(KEY);
            // Output is never recorded.
            expect(serialized).not.toContain('healthy');
        } finally {
            await session?.close();
            provider.stop(true);
            await rm(root, { recursive: true, force: true });
        }
    },
    120000
);

function command(port: number): string {
    return `API_TOKEN=${SECRET} sh -c 'echo shell-e2e' && curl -s -H "Authorization: Bearer ${KEY}" http://127.0.0.1:${port}/health`;
}

type Block = Record<string, unknown>;

function toolUse(value: string): Block {
    return {
        type: 'tool_use',
        id: 'toolu_shell',
        name: 'Bash',
        input: { command: value, description: 'Check the service' },
    };
}

function textBlock(text: string): Block {
    return { type: 'text', text };
}

function message(block: Block): Record<string, unknown> {
    return {
        id: 'msg_fixture',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-4-5',
        content: [block],
        stop_reason: block.type === 'tool_use' ? 'tool_use' : 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 2, output_tokens: 3 },
    };
}

function stream(block: Block): Response {
    const { content: _content, ...start } = message(block);
    const events: [string, Record<string, unknown>][] = [
        [
            'message_start',
            {
                type: 'message_start',
                message: { ...start, content: [], stop_reason: null },
            },
        ],
        [
            'content_block_start',
            {
                type: 'content_block_start',
                index: 0,
                content_block:
                    block.type === 'tool_use'
                        ? { ...block, input: {} }
                        : { type: 'text', text: '' },
            },
        ],
        [
            'content_block_delta',
            {
                type: 'content_block_delta',
                index: 0,
                delta:
                    block.type === 'tool_use'
                        ? {
                              type: 'input_json_delta',
                              partial_json: JSON.stringify(block.input),
                          }
                        : { type: 'text_delta', text: block.text },
            },
        ],
        ['content_block_stop', { type: 'content_block_stop', index: 0 }],
        [
            'message_delta',
            {
                type: 'message_delta',
                delta: { stop_reason: message(block).stop_reason, stop_sequence: null },
                usage: { output_tokens: 3 },
            },
        ],
        ['message_stop', { type: 'message_stop' }],
    ];
    return new Response(
        events
            .map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)
            .join(''),
        { headers: { 'Content-Type': 'text/event-stream' } }
    );
}
