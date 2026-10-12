import { describe, expect, test } from 'bun:test';
import { ModelRouter } from '../src/models/index.js';
import {
    ClaudeCodeSessionAdapter,
    type PreparedClaudeCodeSession,
} from '../src/runners/claude-code/session.js';
import type {
    RunnerPermissionDecision,
    RunnerPermissionRequest,
    RunnerQuestionRequest,
    RunnerQuestionResponse,
    RunnerSession,
    RunnerSessionContext,
} from '../src/runners/session.js';
import type { WorkbenchEventDraft } from '../src/runs/events.js';
import { modelCatalogFixture } from './model-catalog-fixture.js';
import { runnerAdapterContract } from './runner-adapter-contract.js';
import {
    claudeCodeWorkbench,
    FakeClaudeCode,
    PREPARED,
} from './runners/claude-code/fixture.js';

const workbench = claudeCodeWorkbench('/repository');

runnerAdapterContract({
    name: 'Claude Code',
    createHarness() {
        const native = new FakeClaudeCode();
        return {
            adapter: new ClaudeCodeSessionAdapter({
                prepare: async () => ({ session: PREPARED, cleanup: async () => {} }),
                spawn: native.spawn,
            }),
            workbench,
            arrange(scenario) {
                native.scenario = scenario;
            },
        };
    },
});

interface Observed {
    session: RunnerSession;
    native: FakeClaudeCode;
    events: WorkbenchEventDraft[];
    permissions: RunnerPermissionRequest[];
    questions: RunnerQuestionRequest[];
}

async function open(
    options: {
        native?: FakeClaudeCode;
        prepared?: Partial<PreparedClaudeCodeSession>;
        session?: RunnerSessionContext;
        environment?: Record<string, string | undefined>;
        permission?: (
            request: RunnerPermissionRequest
        ) => Promise<RunnerPermissionDecision>;
        question?: (request: RunnerQuestionRequest) => Promise<RunnerQuestionResponse>;
        stopTimeoutMs?: number;
        cleanup?: () => Promise<void>;
    } = {}
): Promise<Observed> {
    const native = options.native ?? new FakeClaudeCode();
    const events: WorkbenchEventDraft[] = [];
    const permissions: RunnerPermissionRequest[] = [];
    const questions: RunnerQuestionRequest[] = [];
    const adapter = new ClaudeCodeSessionAdapter({
        prepare: async () => ({
            session: { ...PREPARED, ...options.prepared },
            cleanup: options.cleanup ?? (async () => {}),
        }),
        spawn: native.spawn,
        stopTimeoutMs: options.stopTimeoutMs ?? 1_000,
    });
    const session = await adapter.start({
        workbench,
        workspaceDirectory: '/workspace',
        environment: options.environment ?? {},
        configuration: new ModelRouter(modelCatalogFixture).resolve({ workbench }),
        ...(options.session ? { session: options.session } : {}),
        host: {
            emit: async (event) => void events.push(event),
            requestPermission: async (request) => {
                permissions.push(request);
                return options.permission ? options.permission(request) : 'allow_once';
            },
            requestQuestion: async (request) => {
                questions.push(request);
                return options.question
                    ? options.question(request)
                    : { outcome: 'rejected' };
            },
        },
    });
    return { session, native, events, permissions, questions };
}

function userLines(native: FakeClaudeCode) {
    return native.lines.filter((line) => line.type === 'user');
}

function lastUser(native: FakeClaudeCode): string {
    return String(userLines(native).at(-1)?.uuid);
}

function texts(events: WorkbenchEventDraft[]): string {
    return events
        .filter((event) => event.type === 'output.text')
        .map((event) => String(event.data.text))
        .join('');
}

async function settle(): Promise<void> {
    for (let index = 0; index < 5; index += 1) await Bun.sleep(0);
}

describe('Claude Code session adapter', () => {
    test('starts a new native session with a fixed id and the stdio prompt tool', async () => {
        const observed = await open({
            prepared: { maxTurns: 7 },
            environment: { PATH: '/bin', CLAUDECODE: '1', ANTHROPIC_BASE_URL: 'x' },
        });
        try {
            const id = observed.session.id;
            expect(id).toMatch(/^[0-9a-f-]{36}$/u);
            expect(observed.native.command).toEqual([
                'claude',
                '-p',
                '--input-format',
                'stream-json',
                '--output-format',
                'stream-json',
                '--verbose',
                '--replay-user-messages',
                '--model',
                'claude-sonnet-4-5',
                '--setting-sources',
                'user',
                '--settings',
                '/staged/settings.json',
                '--strict-mcp-config',
                '--mcp-config',
                '/staged/mcp.json',
                '--append-system-prompt-file',
                '/staged/system.md',
                '--system-prompt-snapshot',
                'off',
                '--permission-prompt-tool',
                'stdio',
                '--session-id',
                String(id),
                '--max-turns',
                '7',
            ]);
            expect(observed.native.env.CLAUDECODE).toBeUndefined();
            expect(observed.native.env.ANTHROPIC_BASE_URL).toBeUndefined();
            expect(observed.native.env.PATH).toBe('/bin');
        } finally {
            await observed.session.close();
        }
    });

    test('reopens a native session with --resume and reports a rotated id', async () => {
        const native = new FakeClaudeCode();
        native.scenario = 'manual';
        const observed = await open({
            native,
            session: {
                id: 'wb_session',
                directory: '/sessions/native',
                nativeSessionId: 'native-before',
            },
        });
        try {
            expect(observed.session.id).toBe('native-before');
            expect(native.command.slice(-2)).toEqual(['--resume', 'native-before']);
            const turn = observed.session.prompt('continue');
            const command = String(
                (await native.waitFor((line) => line.type === 'user')).uuid
            );
            native.turn(command);
            native.emit({
                type: 'system',
                subtype: 'init',
                session_id: 'native-after',
            });
            native.finishTurn(command, { session_id: 'native-after' });
            await turn;
            expect(observed.session.id).toBe('native-after');
        } finally {
            await observed.session.close();
        }
    });

    test('sends images as base64 blocks and never copies them into events', async () => {
        const native = new FakeClaudeCode();
        native.scenario = 'image_input';
        const observed = await open({ native });
        try {
            await observed.session.prompt({
                text: 'inspect',
                images: [{ data: 'aW1hZ2U=', mimeType: 'image/png', name: 'a.png' }],
            });
            expect(userLines(native)[0]?.message).toEqual({
                role: 'user',
                content: [
                    {
                        type: 'image',
                        source: {
                            type: 'base64',
                            media_type: 'image/png',
                            data: 'aW1hZ2U=',
                        },
                    },
                    { type: 'text', text: 'inspect' },
                ],
            });
            expect(JSON.stringify(observed.events)).not.toContain('aW1hZ2U=');
        } finally {
            await observed.session.close();
        }
    });

    test('remembers allow-always for the exact input only and never broadens rules', async () => {
        const native = new FakeClaudeCode();
        native.scenario = 'manual';
        const decisions: RunnerPermissionDecision[] = ['allow_always', 'reject'];
        const observed = await open({
            native,
            permission: async () => decisions.shift() ?? 'reject',
        });
        try {
            const request = (id: string, command: string, extra = {}) =>
                native.emit({
                    type: 'control_request',
                    request_id: id,
                    request: {
                        subtype: 'can_use_tool',
                        tool_name: 'Bash',
                        input: { command, description: 'Run' },
                        permission_suggestions: [
                            {
                                type: 'addRules',
                                rules: [{ toolName: 'Bash', ruleContent: 'echo *' }],
                                behavior: 'allow',
                                destination: 'localSettings',
                            },
                        ],
                        ...extra,
                    },
                });
            request('first', 'echo one');
            await native.waitFor((line) => responseId(line) === 'first');
            request('again', 'echo one');
            await native.waitFor((line) => responseId(line) === 'again');
            request('other', 'echo two');
            await native.waitFor((line) => responseId(line) === 'other');
            request('suppressed', 'echo three', { suppress_always_allow_rule: true });
            await settle();

            expect(observed.permissions.map((entry) => entry.id)).toEqual([
                'first',
                'other',
                'suppressed',
            ]);
            expect(observed.permissions[0]).toEqual({
                id: 'first',
                action: 'Bash',
                resources: ['echo one'],
                message: 'Allow Bash for echo one?',
                allowAlways: true,
            });
            expect(observed.permissions[2]?.allowAlways).toBe(false);
            const responses = native.controlResponses();
            expect(responses.slice(0, 3)).toEqual([
                {
                    subtype: 'success',
                    request_id: 'first',
                    response: {
                        behavior: 'allow',
                        updatedInput: { command: 'echo one', description: 'Run' },
                    },
                },
                {
                    subtype: 'success',
                    request_id: 'again',
                    response: {
                        behavior: 'allow',
                        updatedInput: { command: 'echo one', description: 'Run' },
                    },
                },
                {
                    subtype: 'success',
                    request_id: 'other',
                    response: {
                        behavior: 'deny',
                        message: 'The user denied this tool call.',
                    },
                },
            ]);
            expect(JSON.stringify(native.lines)).not.toContain('updatedPermissions');
        } finally {
            await observed.session.close();
        }
    });

    test('answers questions with labels keyed by question text', async () => {
        const native = new FakeClaudeCode();
        native.scenario = 'manual';
        const observed = await open({
            native,
            question: async () => ({ outcome: 'answered', answers: [['A', 'B']] }),
        });
        try {
            const input = {
                questions: [
                    {
                        question: 'Which?',
                        header: 'Pick',
                        multiSelect: true,
                        options: [
                            { label: 'A', description: 'First' },
                            { label: 'B', description: 'Second' },
                        ],
                    },
                ],
            };
            native.emit({
                type: 'control_request',
                request_id: 'question',
                request: {
                    subtype: 'can_use_tool',
                    tool_name: 'AskUserQuestion',
                    input,
                    requires_user_interaction: true,
                },
            });
            const line = await native.waitFor(
                (entry) => responseId(entry) === 'question'
            );
            expect(observed.questions[0]?.questions).toEqual([
                {
                    question: 'Which?',
                    header: 'Pick',
                    options: [
                        { label: 'A', description: 'First' },
                        { label: 'B', description: 'Second' },
                    ],
                    multiple: true,
                    custom: false,
                },
            ]);
            expect(line.response).toEqual({
                subtype: 'success',
                request_id: 'question',
                response: {
                    behavior: 'allow',
                    updatedInput: { ...input, answers: { 'Which?': 'A, B' } },
                },
            });
        } finally {
            await observed.session.close();
        }
    });

    test('denies prompts without asking when nobody can answer them', async () => {
        const native = new FakeClaudeCode();
        native.scenario = 'manual';
        const observed = await open({ native, prepared: { answersPrompts: false } });
        try {
            expect(native.command).toContain('--permission-prompts');
            expect(native.command).not.toContain('--permission-prompt-tool');
            native.emit({
                type: 'control_request',
                request_id: 'blocked',
                request: { subtype: 'can_use_tool', tool_name: 'Write', input: {} },
            });
            const line = await native.waitFor(
                (entry) => responseId(entry) === 'blocked'
            );
            expect((line.response as Record<string, unknown>).response).toMatchObject({
                behavior: 'deny',
            });
            expect(observed.permissions).toEqual([]);
        } finally {
            await observed.session.close();
        }
    });

    test('answers unknown control requests with an error', async () => {
        const native = new FakeClaudeCode();
        native.scenario = 'manual';
        const observed = await open({ native });
        try {
            native.emit({
                type: 'control_request',
                request_id: 'future',
                request: { subtype: 'future_request' },
            });
            const line = await native.waitFor(
                (entry) => responseId(entry) === 'future'
            );
            expect(line.response).toEqual({
                subtype: 'error',
                request_id: 'future',
                error: 'Workbench does not answer this control request',
            });
        } finally {
            await observed.session.close();
        }
    });

    test('withdraws a host request when Claude Code cancels it', async () => {
        const native = new FakeClaudeCode();
        native.scenario = 'manual';
        let decide!: (decision: RunnerPermissionDecision) => void;
        const observed = await open({
            native,
            permission: () => new Promise((resolve) => (decide = resolve)),
        });
        try {
            native.emit({
                type: 'control_request',
                request_id: 'pending',
                request: { subtype: 'can_use_tool', tool_name: 'Bash', input: {} },
            });
            await settle();
            expect(observed.permissions).toHaveLength(1);
            native.emit({ type: 'control_cancel_request', request_id: 'pending' });
            await settle();
            decide('allow_once');
            await settle();
            expect(native.controlResponses()).toEqual([]);
        } finally {
            await observed.session.close();
        }
    });

    test('holds steering without a tool call in flight and rejects it when the turn ends', async () => {
        const native = new FakeClaudeCode();
        native.scenario = 'manual';
        const observed = await open({ native });
        try {
            const turn = observed.session.prompt('first');
            const command = lastUser(native);
            native.turn(command);
            const steer = await observed.session.steer?.('change course');
            await settle();
            expect(userLines(native)).toHaveLength(1);
            native.assistant([{ type: 'text', text: 'FIRST' }]);
            native.finishTurn(command);
            await expect(turn).resolves.toEqual({ reason: 'end_turn' });
            await expect(steer?.delivered).rejects.toThrow('turn ended');
            expect(userLines(native)).toHaveLength(1);
        } finally {
            await observed.session.close();
        }
    });

    test('writes steering while a tool runs and delivers it when Claude Code starts it', async () => {
        const native = new FakeClaudeCode();
        native.scenario = 'manual';
        const observed = await open({ native });
        try {
            const turn = observed.session.prompt('work');
            const command = lastUser(native);
            native.turn(command);
            const steer = await observed.session.steer?.('steer before the tool');
            native.assistant([
                { type: 'tool_use', id: 'tool', name: 'Bash', input: { command: 'x' } },
            ]);
            const written = await native.waitFor(
                (line) => line.type === 'user' && line.uuid !== command
            );
            native.lifecycle(String(written.uuid), 'queued');
            native.toolResult('tool', 'ok');
            native.lifecycle(String(written.uuid), 'started');
            await expect(steer?.delivered).resolves.toBeUndefined();
            native.assistant([{ type: 'text', text: 'STEERED' }], 'msg_2');
            native.lifecycle(String(written.uuid), 'completed');
            native.finishTurn(command);
            await expect(turn).resolves.toEqual({ reason: 'end_turn' });
            expect(texts(observed.events)).toBe('STEERED');
        } finally {
            await observed.session.close();
        }
    });

    test('interrupts with cancel_queued and keeps the same process for the next turn', async () => {
        const native = new FakeClaudeCode();
        native.scenario = 'steering';
        const observed = await open({ native });
        try {
            const turn = observed.session.prompt('wait');
            const steer = await observed.session.steer?.('queued then cancelled');
            await native.waitFor(
                (line) => line.type === 'user' && userLines(native).length === 2
            );
            await observed.session.cancelTurn();
            await expect(turn).resolves.toEqual({ reason: 'cancelled' });
            await expect(steer?.delivered).rejects.toThrow('cancelled');
            const interrupt = native.lines.find(
                (line) => line.type === 'control_request'
            );
            expect(interrupt?.request).toEqual({
                subtype: 'interrupt',
                cancel_queued: true,
            });
            native.scenario = 'multi_turn';
            await expect(observed.session.prompt('after')).resolves.toEqual({
                reason: 'end_turn',
            });
            expect(texts(observed.events)).toBe('after');
            expect(native.spawns).toBe(1);
        } finally {
            await observed.session.close();
        }
    });

    test('reports an unprompted native turn as session activity, never a reply', async () => {
        const native = new FakeClaudeCode();
        native.scenario = 'manual';
        const observed = await open({ native });
        try {
            native.emit({ type: 'system', subtype: 'task_notification' });
            native.emit({
                type: 'system',
                subtype: 'init',
                session_id: native.sessionId,
            });
            native.assistant([
                { type: 'text', text: 'BACKGROUND' },
                {
                    type: 'tool_use',
                    id: 'read',
                    name: 'Read',
                    input: { file_path: '/x' },
                },
            ]);
            const turn = observed.session.prompt('next');
            native.toolResult('read', 'contents');
            native.emit({
                type: 'result',
                subtype: 'success',
                is_error: false,
                stop_reason: 'end_turn',
                usage: { input_tokens: 2, output_tokens: 3 },
                total_cost_usd: 0.5,
            });
            const command = lastUser(native);
            native.turn(command);
            native.assistant([{ type: 'text', text: 'REPLY' }], 'msg_reply');
            native.finishTurn(command, { total_cost_usd: 0.75 });
            await expect(turn).resolves.toEqual({ reason: 'end_turn' });
            expect(texts(observed.events)).toBe('REPLY');
            expect(observed.events).toContainEqual({
                type: 'runner.event',
                data: { native_type: 'unprompted_turn' },
            });
            expect(
                observed.events
                    .filter((event) => event.type === 'usage.updated')
                    .map((event) => event.data.cost_usd)
            ).toEqual([0.5, 0.25]);
        } finally {
            await observed.session.close();
        }
    });

    test('fails the turn on exit with the redacted stderr error line first', async () => {
        const native = new FakeClaudeCode();
        native.scenario = 'manual';
        const observed = await open({
            native,
            prepared: { routeEnvironment: { ANTHROPIC_API_KEY: 'sk-short-secret' } },
        });
        try {
            const turn = observed.session.prompt('work');
            native.writeStderr('warming up\nError: invalid key sk-short-secret\n');
            await settle();
            native.exit(1);
            await expect(turn).rejects.toThrow(
                'Claude Code session failed: Error: invalid key [redacted] Claude Code exited with code 1'
            );
            await expect(observed.session.prompt('later')).rejects.toThrow('exited');
        } finally {
            await observed.session.close();
        }
    });

    test('fails a startup exit with the standard error tail that arrives after the exit', async () => {
        const encoder = new TextEncoder();
        const observed = await open({
            prepared: {
                // The child exits at once, and its standard error ends later.
                spawn: () => ({
                    exited: Promise.resolve(1),
                    stdin: { write: () => {} },
                    stdout: new ReadableStream({ start: (stream) => stream.close() }),
                    stderr: new ReadableStream({
                        start: async (stream) => {
                            await Bun.sleep(20);
                            stream.enqueue(
                                encoder.encode(
                                    "warming up\ncp: setting permissions for 'skills': Permission denied\n"
                                )
                            );
                            stream.close();
                        },
                    }),
                    kill: () => {},
                }),
            },
        });
        try {
            await expect(observed.session.prompt('work')).rejects.toThrow(
                "Claude Code session failed: warming up cp: setting permissions for 'skills': Permission denied Claude Code exited with code 1"
            );
        } finally {
            await observed.session.close();
        }
    });

    test('fails the turn when the output stream breaks', async () => {
        const native = new FakeClaudeCode();
        native.scenario = 'manual';
        const observed = await open({ native });
        try {
            const turn = observed.session.prompt('work');
            native.failStream();
            await expect(turn).rejects.toThrow('Claude Code output failed');
        } finally {
            await observed.session.close();
        }
    });

    test('stops with SIGTERM, then SIGKILL after a bounded wait, then cleans up', async () => {
        const native = new FakeClaudeCode();
        native.scenario = 'manual';
        native.exitsOnTerm = false;
        let cleaned = false;
        const observed = await open({
            native,
            stopTimeoutMs: 20,
            cleanup: async () => {
                cleaned = true;
            },
        });
        const turn = observed.session.prompt('work');
        await observed.session.close();
        expect(native.signals).toEqual(['SIGTERM', 'SIGKILL']);
        expect(cleaned).toBe(true);
        await expect(turn).resolves.toEqual({ reason: 'cancelled' });
    });
});

function responseId(line: Record<string, unknown>): string | undefined {
    if (line.type !== 'control_response') return undefined;
    return String((line.response as Record<string, unknown>).request_id);
}
