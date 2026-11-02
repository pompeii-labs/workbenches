import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { launchLocalOpenCodeServer } from '../../src/runners/opencode/server.js';
import { OpenCodeServerSession } from '../../src/runners/opencode/session.js';
import type { WorkbenchEventDraft } from '../../src/runs/index.js';
import { fixtureConfiguration, fixtureWorkbench } from '../runners/opencode/fixture.js';

// A stdio MCP server with two tools, written in the shape of a real one.
const mcpServer = `
import { createInterface } from 'node:readline';
const tools = ['compose_music', 'speak'].map((name) => ({
    name,
    description: 'Fixture ' + name,
    inputSchema: { type: 'object', properties: {} },
}));
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\\n');
createInterface({ input: process.stdin }).on('line', (line) => {
    const message = JSON.parse(line);
    if (message.id === undefined) return;
    if (message.method === 'initialize')
        return send({ id: message.id, result: {
            protocolVersion: message.params.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: 'fixture', version: '1.0.0' },
        } });
    if (message.method === 'tools/list') return send({ id: message.id, result: { tools } });
    if (message.method === 'tools/call')
        return send({ id: message.id, result: { content: [{ type: 'text', text: 'called ' + message.params.name + ' with ' + process.env.FIXTURE_MCP_KEY }] } });
    send({ id: message.id, error: { code: -32601, message: 'Method not found' } });
});
`;

// No provider credentials or paid model requests. The real V2 binary starts
// the package's own MCP servers and sends its model requests to a loopback
// OpenAI-compatible fixture, which records the tools each request offers.
test.skipIf(process.env.WORKBENCH_OPENCODE_V2_E2E !== '1')(
    'real OpenCode V2 gives the first turn the tools of runner_config MCP servers',
    async () => {
        const root = await mkdtemp('/tmp/opencode/wb-v2-mcp-live-');
        const offered: string[][] = [];
        const bodies: string[] = [];
        const provider = Bun.serve({
            hostname: '127.0.0.1',
            port: 0,
            fetch: async (request) => {
                const body = (await request.json()) as {
                    stream?: boolean;
                    tools?: { function?: { name?: string } }[];
                };
                const base = {
                    id: 'chatcmpl-test',
                    object: 'chat.completion.chunk',
                    created: 1,
                    model: 'fixture',
                };
                if (!body.stream)
                    return Response.json({
                        ...base,
                        object: 'chat.completion',
                        choices: [
                            {
                                index: 0,
                                message: { role: 'assistant', content: 'Title' },
                                finish_reason: 'stop',
                            },
                        ],
                    });
                offered.push(
                    (body.tools ?? []).map((tool) => String(tool.function?.name))
                );
                bodies.push(JSON.stringify(body));
                const usage = {
                    prompt_tokens: 2,
                    completion_tokens: 3,
                    total_tokens: 5,
                };
                const chunks =
                    offered.length === 1
                        ? [
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
                                                      id: 'call_fixture',
                                                      type: 'function',
                                                      function: {
                                                          name: 'fixture_compose_music',
                                                          arguments: '{}',
                                                      },
                                                  },
                                              ],
                                          },
                                          finish_reason: null,
                                      },
                                  ],
                              },
                              {
                                  ...base,
                                  choices: [
                                      {
                                          index: 0,
                                          delta: {},
                                          finish_reason: 'tool_calls',
                                      },
                                  ],
                                  usage,
                              },
                          ]
                        : [
                              {
                                  ...base,
                                  choices: [
                                      {
                                          index: 0,
                                          delta: { role: 'assistant', content: 'Done' },
                                          finish_reason: null,
                                      },
                                  ],
                              },
                              {
                                  ...base,
                                  choices: [
                                      { index: 0, delta: {}, finish_reason: 'stop' },
                                  ],
                                  usage,
                              },
                          ];
                return new Response(
                    `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`,
                    { headers: { 'Content-Type': 'text/event-stream' } }
                );
            },
        });
        let session: OpenCodeServerSession | undefined;
        try {
            const version = Bun.spawnSync(['opencode', '--version']).stdout.toString();
            expect(version).toMatch(/^(?:opencode\s+)?v?2\./);
            const workspace = join(root, 'workspace');
            const runner = join(root, 'package', 'runner');
            await mkdir(workspace, { recursive: true });
            await mkdir(runner, { recursive: true });
            await writeFile(join(root, 'package', 'instructions.md'), 'Reply briefly.');
            const server = join(root, 'package', 'mcp.mjs');
            await writeFile(server, mcpServer);
            const local = (codemode?: boolean) => ({
                type: 'local',
                command: [process.execPath, server],
                environment: { FIXTURE_MCP_KEY: '{env:FIXTURE_MCP_KEY}' },
                enabled: true,
                timeout: 20000,
                ...(codemode === undefined ? {} : { codemode }),
            });
            const config = join(runner, 'opencode.json');
            await writeFile(
                config,
                JSON.stringify({
                    mcp: { fixture: local(false), coded: local() },
                    permission: {
                        'fixture_*': 'deny',
                        fixture_compose_music: 'allow',
                        'coded_*': 'ask',
                    },
                    providers: {
                        fixture: {
                            package: '@opencode/ai/providers/openai-compatible',
                            settings: {
                                baseURL: `http://127.0.0.1:${provider.port}/v1`,
                            },
                            models: {
                                fixture: {
                                    limit: { context: 32000, output: 1000 },
                                    capabilities: { tools: true },
                                },
                            },
                        },
                    },
                    agents: { title: { model: 'fixture/fixture' } },
                })
            );
            const workbench = fixtureWorkbench(join(root, 'package'), workspace);
            workbench.runnerConfigPath = config;
            const environment = {
                PATH: process.env.PATH,
                HOME: root,
                XDG_DATA_HOME: join(root, 'data'),
                XDG_CONFIG_HOME: join(root, 'config'),
                XDG_CACHE_HOME: join(root, 'cache'),
                OPENCODE_DB: join(root, 'native.db'),
                FIXTURE_MCP_KEY: 'fixture-placeholder',
            };
            const imported = Bun.spawn(['opencode', 'auth', 'import', '--standalone'], {
                env: { ...environment, OPENCODE_CONFIG: config },
                stdin: new Blob([
                    JSON.stringify([
                        {
                            id: 'cred_fixture',
                            integrationID: 'fixture',
                            label: 'fixture',
                            active: true,
                            value: { type: 'key', key: 'fixture-key' },
                        },
                    ]),
                ]),
                stdout: 'ignore',
                stderr: 'ignore',
            });
            expect(await imported.exited).toBe(0);
            const events: WorkbenchEventDraft[] = [];
            session = new OpenCodeServerSession({
                workbench,
                workspaceDirectory: workspace,
                environment,
                configuration: {
                    ...fixtureConfiguration(workbench),
                    model: 'fixture/fixture',
                },
                nativeConfigFile: config,
                host: {
                    emit: async (event) => {
                        events.push(event);
                    },
                    requestPermission: async () => 'reject',
                    requestQuestion: async () => ({ outcome: 'rejected' }),
                },
                fetch,
                password: () => 'fixture-password',
                launch: launchLocalOpenCodeServer(),
                startupTimeoutMs: 20000,
                authenticationTimeoutMs: 1000,
                cleanup: async () => {},
            });
            await session.start();
            expect(await session.prompt('Compose some music')).toEqual({
                reason: 'stop',
            });

            // The first request already offers the MCP tools, under their
            // V1 names, with the denied one hidden.
            const first = offered[0] ?? [];
            expect(first).toContain('fixture_compose_music');
            expect(first).not.toContain('fixture_speak');
            // A server without `codemode: false` is reachable only through `execute`.
            expect(first).not.toContain('coded_speak');
            expect(first).toContain('execute');
            expect(bodies[0]).toContain('tools.coded.speak');
            const tool = events.find((event) => event.type === 'tool.completed');
            expect(tool?.data).toMatchObject({
                name: 'fixture_compose_music',
                status: 'completed',
            });
            expect(
                events
                    .filter((event) => event.type === 'output.text')
                    .map((event) => event.data.text)
                    .join('')
            ).toBe('Done');
        } finally {
            await session?.close();
            provider.stop(true);
            await rm(root, { recursive: true, force: true });
        }
    },
    90000
);
