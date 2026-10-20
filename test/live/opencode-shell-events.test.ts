import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchLocalOpenCodeServer } from '../../src/runners/opencode/server.js';
import { OpenCodeServerSession } from '../../src/runners/opencode/session.js';
import type { WorkbenchEventDraft } from '../../src/runs/index.js';
import { fixtureConfiguration, fixtureWorkbench } from '../runners/opencode/fixture.js';

const SECRET = 'MUST_NOT_RENDER_SHELL_SECRET';
const KEY = 'sk-or-v1-0123456789abcdef0123456789abcdef0123456789abcdef';

// No provider credentials or paid model requests. The real OpenCode binary talks
// only to a loopback OpenAI-compatible fixture that asks for one shell call
// carrying credentials, which OpenCode really runs, then finishes the turn.
test.skipIf(process.env.WORKBENCH_SHELL_EVENTS_E2E !== '1')(
    'real OpenCode shell calls cross the event boundary without their credentials',
    async () => {
        const root = await mkdtemp(join(tmpdir(), 'wb-shell-events-'));
        const health: string[] = [];
        const provider = Bun.serve({
            hostname: '127.0.0.1',
            port: 0,
            fetch: async (request): Promise<Response> => {
                if (request.method === 'GET') {
                    health.push(request.headers.get('authorization') ?? '');
                    return new Response('healthy');
                }
                const body = (await request.json()) as {
                    tools?: unknown[];
                    messages?: { role?: string }[];
                };
                const answered = body.messages?.some(
                    (message) => message.role === 'tool'
                );
                if (!body.tools?.length || answered) return stream(text('done'));
                return stream(shellCall(command(Number(new URL(request.url).port))));
            },
        });
        let session: OpenCodeServerSession | undefined;
        try {
            const workspace = join(root, 'workspace');
            await mkdir(workspace);
            const instructions = join(root, 'instructions.md');
            await writeFile(instructions, 'Run the requested command.');
            const config = join(root, 'opencode.json');
            await writeFile(
                config,
                JSON.stringify({
                    $schema: 'https://opencode.ai/config.json',
                    provider: {
                        fixture: {
                            npm: '@ai-sdk/openai-compatible',
                            name: 'Fixture',
                            options: {
                                baseURL: `http://127.0.0.1:${provider.port}/v1`,
                                apiKey: 'fixture-key',
                            },
                            models: { fixture: { name: 'Fixture', tool_call: true } },
                        },
                    },
                    permission: { bash: 'allow' },
                    small_model: 'fixture/fixture',
                })
            );
            const workbench = fixtureWorkbench(root, workspace);
            workbench.instructionsPath = instructions;
            const events: WorkbenchEventDraft[] = [];
            session = new OpenCodeServerSession({
                workbench,
                workspaceDirectory: workspace,
                environment: {
                    PATH: process.env.PATH,
                    HOME: root,
                    XDG_DATA_HOME: join(root, 'data'),
                    XDG_CONFIG_HOME: join(root, 'config'),
                    XDG_CACHE_HOME: join(root, 'cache'),
                    XDG_STATE_HOME: join(root, 'state'),
                },
                configuration: {
                    ...fixtureConfiguration(workbench),
                    model: 'fixture/fixture',
                },
                nativeConfigFile: config,
                host: {
                    emit: async (event) => {
                        events.push(event);
                    },
                    requestPermission: async () => 'allow_once',
                    requestQuestion: async () => ({ outcome: 'rejected' }),
                },
                fetch,
                password: () => 'fixture-password',
                launch: launchLocalOpenCodeServer(),
                startupTimeoutMs: 60000,
                authenticationTimeoutMs: 1000,
                cleanup: async () => {},
            });
            await session.start();
            expect(await session.prompt('Check the service')).toEqual({
                reason: 'stop',
            });

            // The command really ran with its credentials.
            expect(health).toEqual([`Bearer ${KEY}`]);
            const shell = events.find(
                (event) => event.type === 'tool.completed' && event.data.name === 'bash'
            );
            expect(shell?.data).toEqual(
                expect.objectContaining({
                    title: 'Check the service',
                    target: `API_TOKEN=[REDACTED] sh -c 'echo shell-e2e' && curl -s -H "Authorization: [REDACTED]" http://127.0.0.1:${provider.port}/health; exit 3`,
                    programs: ['echo', 'curl', 'exit'],
                    exit_code: 3,
                    status: 'completed',
                })
            );
            const serialized = JSON.stringify(events);
            expect(serialized).not.toContain(SECRET);
            expect(serialized).not.toContain(KEY);
            // Output is never recorded.
            expect(serialized).not.toContain('healthy');
            expect(serialized).not.toContain('shell-e2e\n');
        } finally {
            await session?.close();
            provider.stop(true);
            await rm(root, { recursive: true, force: true });
        }
    },
    120000
);

function command(port: number): string {
    return `API_TOKEN=${SECRET} sh -c 'echo shell-e2e' && curl -s -H "Authorization: Bearer ${KEY}" http://127.0.0.1:${port}/health; exit 3`;
}

const base = {
    id: 'chatcmpl-shell',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'fixture',
};
const usage = { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 };

function text(content: string): Record<string, unknown>[] {
    return [
        { ...base, choices: [{ index: 0, delta: { role: 'assistant', content } }] },
        { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage },
    ];
}

function shellCall(value: string): Record<string, unknown>[] {
    return [
        {
            ...base,
            choices: [
                {
                    index: 0,
                    delta: {
                        role: 'assistant',
                        tool_calls: [
                            {
                                index: 0,
                                id: 'call_shell',
                                type: 'function',
                                function: {
                                    name: 'bash',
                                    arguments: JSON.stringify({
                                        command: value,
                                        description: 'Check the service',
                                    }),
                                },
                            },
                        ],
                    },
                },
            ],
        },
        {
            ...base,
            choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
            usage,
        },
    ];
}

function stream(chunks: Record<string, unknown>[]): Response {
    return new Response(
        `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`,
        { headers: { 'Content-Type': 'text/event-stream' } }
    );
}
