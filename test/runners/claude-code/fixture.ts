import type {
    ClaudeCodeChild,
    ClaudeCodeSpawn,
} from '../../../src/runners/claude-code/process.js';
import type { PreparedClaudeCodeSession } from '../../../src/runners/claude-code/session.js';
import type { ResolvedWorkbench } from '../../../src/types.js';
import type { RunnerConformanceScenario } from '../../runner-adapter-contract.js';

export const PREPARED: PreparedClaudeCodeSession = {
    paths: {
        configDirectory: '/staged/config',
        mcpConfigPath: '/staged/mcp.json',
        systemPromptPath: '/staged/system.md',
    },
    settings: '/staged/settings.json',
    routeEnvironment: {},
    secureStorageDirectory: '',
    scrubSubprocessEnvironment: false,
    answersPrompts: true,
};

export function claudeCodeWorkbench(root: string): ResolvedWorkbench {
    return {
        manifestPath: `${root}/.workbenches/core/workbench.yml`,
        packageDirectory: `${root}/.workbenches/core`,
        repositoryDirectory: root,
        instructionsPath: `${root}/.workbenches/core/instructions.md`,
        skills: [],
        manifest: {
            spec: 0,
            version: '0.1.0',
            name: 'claude-code-contract',
            runner: 'claude-code',
            model: { id: 'anthropic/claude-sonnet-4-5' },
            instructions: './instructions.md',
            skills: [],
            tools: [],
            mcps: [],
            env: {},
            runtime: 'local',
        },
    };
}

type Line = Record<string, unknown>;

/**
 * An in-memory `claude -p` stream-json child. Each user message becomes a
 * native turn shaped like the recorded traces, scripted by `scenario`. Tests can
 * also drive it directly with `emit`, `turn`, and `finishTurn`.
 */
export class FakeClaudeCode {
    scenario: RunnerConformanceScenario | 'manual' = 'streaming_text';
    readonly lines: Line[] = [];
    readonly signals: string[] = [];
    command: string[] = [];
    env: Record<string, string | undefined> = {};
    spawns = 0;
    /** Whether SIGTERM ends the child. */
    exitsOnTerm = true;
    private stdoutController!: ReadableStreamDefaultController<Uint8Array>;
    private stderrController!: ReadableStreamDefaultController<Uint8Array>;
    private finish!: (code: number) => void;
    private done = false;
    private broken = false;
    private readonly encoder = new TextEncoder();
    private readonly waiters: Array<{
        test: (line: Line) => boolean;
        resolve: (line: Line) => void;
    }> = [];
    private active: string | undefined;
    private readonly queued = new Set<string>();
    private pendingControl: ((response: Line) => void) | undefined;

    readonly spawn: ClaudeCodeSpawn = (command, options) => {
        this.spawns += 1;
        this.command = command;
        this.env = options.env;
        const stdout = new ReadableStream<Uint8Array>({
            start: (controller) => {
                this.stdoutController = controller;
            },
        });
        const stderr = new ReadableStream<Uint8Array>({
            start: (controller) => {
                this.stderrController = controller;
            },
        });
        const exited = new Promise<number>((resolve) => {
            this.finish = resolve;
        });
        const child: ClaudeCodeChild = {
            nativePipes: false,
            exited,
            stdin: {
                write: (value: string) => this.receive(value),
                end: () => {},
            },
            stdout,
            stderr,
            kill: (signal) => {
                this.signals.push(signal ?? 'SIGTERM');
                if (signal === 'SIGKILL' || this.exitsOnTerm) this.exit(143);
            },
        };
        return child;
    };

    get sessionId(): string {
        const index = this.command.findIndex(
            (value) => value === '--session-id' || value === '--resume'
        );
        return this.command[index + 1] ?? 'missing';
    }

    /** The first stdin line, now or later, that passes the test. */
    waitFor(test: (line: Line) => boolean): Promise<Line> {
        const seen = this.lines.find(test);
        if (seen) return Promise.resolve(seen);
        return new Promise((resolve) => this.waiters.push({ test, resolve }));
    }

    controlResponses(): Line[] {
        return this.lines
            .filter((line) => line.type === 'control_response')
            .map((line) => line.response as Line);
    }

    emit(value: Line): void {
        if (!this.done && !this.broken) {
            this.stdoutController.enqueue(
                this.encoder.encode(`${JSON.stringify(value)}\n`)
            );
        }
    }

    writeStderr(text: string): void {
        if (!this.done) this.stderrController.enqueue(this.encoder.encode(text));
    }

    failStream(): void {
        if (this.done || this.broken) return;
        this.broken = true;
        this.stdoutController.error(new Error('native stream failure'));
    }

    exit(code: number): void {
        if (this.done) return;
        this.done = true;
        if (!this.broken) this.stdoutController.close();
        this.stderrController.close();
        this.finish(code);
    }

    /** Starts a native turn for a command, as Claude Code does on a fresh prompt. */
    turn(command: string): void {
        this.active = command;
        this.lifecycle(command, 'queued');
        this.lifecycle(command, 'started');
        this.emit({ type: 'system', subtype: 'init', session_id: this.sessionId });
    }

    finishTurn(command: string, result: Line = {}): void {
        this.emit({
            type: 'result',
            subtype: 'success',
            is_error: false,
            stop_reason: 'end_turn',
            result: '',
            session_id: this.sessionId,
            usage: { input_tokens: 1, output_tokens: 1 },
            ...result,
        });
        this.lifecycle(command, 'completed');
        if (this.active === command) this.active = undefined;
    }

    lifecycle(command: string, state: string): void {
        this.emit({
            type: 'command_lifecycle',
            command_uuid: command,
            state,
            session_id: this.sessionId,
        });
    }

    assistant(content: Line[], id = 'msg_fake', parent: string | null = null): void {
        this.emit({
            type: 'assistant',
            message: { id, role: 'assistant', content },
            parent_tool_use_id: parent,
            session_id: this.sessionId,
        });
    }

    toolResult(id: string, content: string, isError = false): void {
        this.emit({
            type: 'user',
            message: {
                role: 'user',
                content: [
                    {
                        type: 'tool_result',
                        tool_use_id: id,
                        content,
                        is_error: isError,
                    },
                ],
            },
            parent_tool_use_id: null,
            session_id: this.sessionId,
        });
    }

    private receive(value: string): void {
        const line = JSON.parse(value.trim()) as Line;
        this.lines.push(line);
        for (const waiter of [...this.waiters]) {
            if (waiter.test(line)) {
                this.waiters.splice(this.waiters.indexOf(waiter), 1);
                waiter.resolve(line);
            }
        }
        queueMicrotask(() => this.respond(line));
    }

    private respond(line: Line): void {
        if (this.scenario === 'manual') return;
        if (line.type === 'control_response') {
            const pending = this.pendingControl;
            this.pendingControl = undefined;
            pending?.(line.response as Line);
            return;
        }
        if (line.type === 'control_request') {
            this.interrupt(line);
            return;
        }
        if (line.type !== 'user') return;
        const command = String(line.uuid);
        if (this.active) {
            this.queued.add(command);
            this.lifecycle(command, 'queued');
            return;
        }
        this.turn(command);
        this.emit({ ...line, session_id: this.sessionId, isReplay: true });
        this.script(command, line);
    }

    private script(command: string, line: Line): void {
        const text = textOf(line);
        if (this.scenario === 'streaming_text') {
            this.assistant([
                { type: 'thinking', thinking: 'MUST_NOT_RENDER_REASONING' },
            ]);
            this.assistant([{ type: 'text', text: 'Hello' }]);
            this.assistant([{ type: 'text', text: ' world' }]);
        } else if (this.scenario === 'multi_turn') {
            this.assistant([{ type: 'text', text }], `msg_${text}`);
        } else if (this.scenario === 'image_input') {
            this.assistant([{ type: 'text', text: 'image received' }]);
        } else if (this.scenario === 'tool_events') {
            this.assistant([
                {
                    type: 'tool_use',
                    id: 'call_contract',
                    name: 'write',
                    input: {
                        file_path: '/workspace/output.txt',
                        content: 'MUST_NOT_RENDER_TOOL_OUTPUT',
                    },
                },
            ]);
            this.toolResult('call_contract', 'MUST_NOT_RENDER_TOOL_OUTPUT');
            this.finishTurn(command, {
                usage: { input_tokens: 5, output_tokens: 7 },
                total_cost_usd: 0.001,
            });
            return;
        } else if (this.scenario === 'permissions') {
            this.toolThenControl(command, 'call_permission', {
                request_id: 'permission_contract',
                request: {
                    subtype: 'can_use_tool',
                    tool_name: 'external_directory',
                    input: { path: '/outside/file.txt' },
                    blocked_path: '/outside/*',
                    permission_suggestions: [
                        {
                            type: 'setMode',
                            mode: 'acceptEdits',
                            destination: 'session',
                        },
                    ],
                    tool_use_id: 'call_permission',
                },
            });
            return;
        } else if (this.scenario === 'questions') {
            this.toolThenControl(command, 'call_question', {
                request_id: 'question_contract',
                request: {
                    subtype: 'can_use_tool',
                    tool_name: 'AskUserQuestion',
                    input: {
                        questions: [
                            {
                                question: 'Where should this deploy?',
                                options: [
                                    { label: 'Production' },
                                    { label: 'Staging' },
                                ],
                                multiSelect: false,
                            },
                        ],
                    },
                    tool_use_id: 'call_question',
                    requires_user_interaction: true,
                },
            });
            return;
        } else if (this.scenario === 'steering') {
            this.assistant([
                {
                    type: 'tool_use',
                    id: 'call_running',
                    name: 'Bash',
                    input: { command: 'MUST_NOT_RENDER_COMMAND', description: 'Wait' },
                },
            ]);
            return;
        } else if (this.scenario === 'cancellation') {
            return;
        } else if (this.scenario === 'failures') {
            this.finishTurn(command, {
                is_error: true,
                result: 'API Error: MUST_NOT_RENDER_CREDENTIAL',
            });
            return;
        } else if (this.scenario === 'unknown_events') {
            this.emit({
                type: 'future.event',
                credential: 'MUST_NOT_RENDER_CREDENTIAL',
            });
        }
        this.finishTurn(command);
    }

    private toolThenControl(command: string, toolId: string, request: Line): void {
        const native = request.request as Line;
        this.assistant([
            {
                type: 'tool_use',
                id: toolId,
                name: native.tool_name,
                input: native.input,
            },
        ]);
        this.pendingControl = (response) => {
            const reply = response.response as Line;
            this.toolResult(toolId, 'done', reply.behavior !== 'allow');
            this.finishTurn(command);
        };
        this.emit({ type: 'control_request', ...request });
    }

    /** Interrupts as the recorded traces show: cancel queued, ack, then end the turn. */
    private interrupt(line: Line): void {
        const command = this.active;
        const queued = [...this.queued];
        this.queued.clear();
        for (const uuid of queued) this.lifecycle(uuid, 'cancelled');
        this.emit({
            type: 'control_response',
            response: {
                subtype: 'success',
                request_id: line.request_id,
                response: { still_queued: [], cancelled: queued },
            },
        });
        if (!command) return;
        this.emit({
            type: 'result',
            subtype: 'error_during_execution',
            is_error: true,
            stop_reason: 'tool_use',
            session_id: this.sessionId,
            usage: { input_tokens: 1, output_tokens: 1 },
            errors: ['[ede_diagnostic] result_type=user'],
        });
        this.lifecycle(command, 'cancelled');
        this.active = undefined;
    }
}

function textOf(line: Line): string {
    const content = (line.message as Line).content;
    if (typeof content === 'string') return content;
    const text = (content as Line[]).find((block) => block.type === 'text');
    return String(text?.text ?? '');
}
