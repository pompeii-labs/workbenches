import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { openCodeConnection } from '../../src/runners/opencode/connection.js';
import { launchLocalOpenCodeServer } from '../../src/runners/opencode/server.js';
import { OpenCodeServerSession } from '../../src/runners/opencode/session.js';
import { fixtureConfiguration, fixtureWorkbench } from '../runners/opencode/fixture.js';

// No provider credentials or paid model requests. The real V2 binary talks only
// to a loopback OpenAI-compatible fixture, with its own data/config directories.
test.skipIf(process.env.WORKBENCH_OPENCODE_V2_E2E !== '1')(
    'real OpenCode V2 streams and resumes native sessions',
    async () => {
        const root = await mkdtemp('/tmp/opencode/wb-v2-live-');
        const provider = Bun.serve({
            hostname: '127.0.0.1',
            port: 0,
            fetch: async (request) => {
                const body = (await request.json()) as { stream?: boolean };
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
                                message: { role: 'assistant', content: 'V2 works' },
                                finish_reason: 'stop',
                            },
                        ],
                        usage: {
                            prompt_tokens: 2,
                            completion_tokens: 3,
                            total_tokens: 5,
                        },
                    });
                return new Response(
                    `${[
                        {
                            ...base,
                            choices: [
                                {
                                    index: 0,
                                    delta: { role: 'assistant', content: 'V2 works' },
                                    finish_reason: null,
                                },
                            ],
                        },
                        {
                            ...base,
                            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
                            usage: {
                                prompt_tokens: 2,
                                completion_tokens: 3,
                                total_tokens: 5,
                            },
                        },
                    ]
                        .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
                        .join('')}data: [DONE]\n\n`,
                    { headers: { 'Content-Type': 'text/event-stream' } }
                );
            },
        });
        let session: OpenCodeServerSession | undefined;
        try {
            const workspace = join(root, 'workspace');
            await mkdir(workspace);
            const instructions = join(root, 'instructions.md');
            await writeFile(instructions, 'Reply briefly.');
            const config = join(root, 'opencode.json');
            await writeFile(
                config,
                JSON.stringify({
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
            const workbench = fixtureWorkbench(root, workspace);
            workbench.instructionsPath = instructions;
            const output: string[] = [];
            const environment = {
                PATH: process.env.PATH,
                HOME: root,
                XDG_DATA_HOME: join(root, 'data'),
                XDG_CONFIG_HOME: join(root, 'config'),
                XDG_CACHE_HOME: join(root, 'cache'),
                OPENCODE_DB: join(root, 'native.db'),
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
                stderr: 'pipe',
            });
            const importError = await new Response(imported.stderr).text();
            expect({
                code: await imported.exited,
                error: importError.includes('Imported 1 credential'),
            }).toEqual({ code: 0, error: true });
            expect(
                await openCodeConnection.hostSignIn?.exportCredential?.(
                    'opencode',
                    { ...environment, OPENCODE_CONFIG: config },
                    'fixture',
                    '2.0.29'
                )
            ).toEqual({ type: 'api', key: 'fixture-key' });
            const start = async (nativeSessionId?: string) => {
                const next = new OpenCodeServerSession({
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
                            if (event.type === 'output.text')
                                output.push(String(event.data.text));
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
                    ...(nativeSessionId
                        ? {
                              session: {
                                  id: 'wb_fixture',
                                  directory: root,
                                  nativeSessionId,
                              },
                          }
                        : {}),
                });
                await next.start();
                return next;
            };
            session = await start();
            expect(await session.prompt('Say hello')).toEqual({ reason: 'stop' });
            const id = session.id;
            expect(id).toBeTruthy();
            await session.close();
            session = await start(id);
            expect(await session.prompt('Say hello again')).toEqual({ reason: 'stop' });
            expect(output.join('')).toBe('V2 worksV2 works');
        } finally {
            await session?.close();
            provider.stop(true);
            await rm(root, { recursive: true, force: true });
        }
    },
    60000
);
