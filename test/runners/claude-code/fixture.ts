import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ModelRouter } from '../../../src/models/index.js';
import type { ResolvedWorkbench, SpawnedRunner } from '../../../src/types.js';
import { modelCatalogFixture } from '../../model-catalog-fixture.js';
import type { RunnerConformanceScenario } from '../../runner-adapter-contract.js';

export function claudeCodeWorkbench(): ResolvedWorkbench {
    return {
        manifestPath: '/package/workbench.yml',
        packageDirectory: '/package',
        repositoryDirectory: '/workspace',
        instructionsPath: '/package/instructions.md',
        runnerConfigPath: '/package/runner.json',
        skills: [
            {
                name: 'review',
                directory: '/package/skills/review',
                manifestPath: '/package/skills/review/SKILL.md',
            },
        ],
        manifest: {
            spec: 1,
            version: '0.1.0',
            name: 'claude-code-fixture',
            runner: 'claude-code',
            model: { id: 'anthropic/claude-sonnet-4-5' },
            instructions: './instructions.md',
            runner_config: './runner.json',
            skills: ['./skills/review'],
            tools: [],
            mcps: [],
            env: {},
            runtimes: { local: {} },
        },
    };
}

export function claudeCodeConfiguration(workbench = claudeCodeWorkbench()) {
    return new ModelRouter(modelCatalogFixture).resolve({
        workbench,
        authenticatedRoutes: [
            {
                provider: 'anthropic',
                nativeProvider: 'anthropic',
                nativeModel: 'claude-sonnet-4-5',
                authenticationMethod: 'api',
            },
        ],
    });
}

export class FakeClaudeCode {
    scenario:
        | RunnerConformanceScenario
        | 'restart'
        | 'malformed_stream'
        | 'control_request'
        | 'exit_without_result'
        | 'events_after_cancel'
        | 'ignore_sigterm'
        | 'stray_result'
        | 'permission_deny'
        | 'permission_allow'
        | 'permission_always'
        | 'questions_multiple'
        | 'question_reject'
        | 'pending_request'
        | 'held_steering'
        | 'separate_steering'
        | 'cancelled_request'
        | 'between_turn_request'
        | 'queued_steering'
        | 'control_plane'
        | 'background_turn'
        | 'asynchronous_write_failure'
        | 'synchronous_write_throw' = 'streaming_text';
    readonly invocations: Array<{
        command: string[];
        env: Record<string, string | undefined>;
        input: string[];
        killed: boolean;
        kills: unknown[];
    }> = [];

    spawn = (invocation: {
        command: string[];
        env: Record<string, string | undefined>;
    }): SpawnedRunner => {
        const scenario = this.scenario;
        const input: string[] = [];
        const recorded: (typeof this.invocations)[number] = {
            command: [...invocation.command],
            env: { ...invocation.env },
            input,
            killed: false,
            kills: [],
        };
        this.invocations.push(recorded);
        let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
        let exit: ((code: number) => void) | undefined;
        const exited = new Promise<number>((resolve) => {
            exit = resolve;
        });
        const stdout = new ReadableStream<Uint8Array>({
            start(value) {
                controller = value;
            },
        });
        let settled = false;
        let nativeTurnOpen = false;
        let currentCommand: string | undefined;
        const foldedCommands = new Set<string>();
        const sessionId = () =>
            invocationValue(recorded.command, '--session-id') ??
            invocationValue(recorded.command, '--resume') ??
            'claude-contract-session';
        const enqueue = (event: unknown) => {
            controller?.enqueue(new TextEncoder().encode(`${JSON.stringify(event)}\n`));
        };
        const lifecycle = (commandUuid: string, state: string) => {
            enqueue({
                type: 'command_lifecycle',
                command_uuid: commandUuid,
                state,
                session_id: sessionId(),
            });
        };
        const queue = (message: Record<string, unknown>) => {
            const uuid = string(message.uuid);
            if (uuid) lifecycle(uuid, 'queued');
        };
        const start = (message: Record<string, unknown>, ownTurn: boolean) => {
            const uuid = string(message.uuid);
            if (!uuid) return;
            lifecycle(uuid, 'started');
            if (!nativeTurnOpen) {
                enqueue({
                    type: 'system',
                    subtype: 'init',
                    session_id: sessionId(),
                });
                nativeTurnOpen = true;
            }
            enqueue({ ...message, session_id: sessionId(), isReplay: true });
            if (ownTurn) currentCommand = uuid;
        };
        const finish = () => {
            if (settled) return;
            const command = currentCommand;
            for (const event of this.events(input)) {
                enqueue(event);
            }
            nativeTurnOpen = false;
            if (command) lifecycle(command, 'completed');
            currentCommand = undefined;
            if (this.scenario === 'restart') {
                settled = true;
                controller?.close();
                exit?.(0);
            }
        };
        const cancel = (signal?: unknown) => {
            if (settled) return;
            recorded.kills.push(signal);
            if (this.scenario === 'ignore_sigterm' && signal !== 'SIGKILL') return;
            settled = true;
            recorded.killed = true;
            if (this.scenario === 'events_after_cancel') {
                controller?.enqueue(
                    new TextEncoder().encode(
                        `${JSON.stringify(assistant([{ type: 'text', text: 'late' }]))}\n`
                    )
                );
            }
            controller?.close();
            exit?.(143);
        };
        return {
            exited,
            stdin: {
                write: (value) => {
                    if (this.scenario === 'synchronous_write_throw') {
                        throw new Error('synchronous stdin failure');
                    }
                    input.push(String(value));
                    const message = parseLine(value);
                    if (
                        this.scenario === 'asynchronous_write_failure' &&
                        message?.type === 'control_response'
                    ) {
                        return Promise.reject(new Error('asynchronous stdin failure'));
                    }
                    if (
                        message?.type === 'user' &&
                        this.scenario === 'stray_result' &&
                        input.length === 2
                    ) {
                        enqueue(result(undefined, undefined, sessionId()));
                    }
                    if (
                        message?.type === 'user' &&
                        this.scenario === 'separate_steering' &&
                        currentCommand
                    ) {
                        queue(message);
                        enqueue(toolResult());
                        enqueue(
                            assistant(
                                [{ type: 'text', text: 'current turn' }],
                                'end_turn',
                                sessionId()
                            )
                        );
                        enqueue(result(undefined, undefined, sessionId()));
                        lifecycle(currentCommand, 'completed');
                        currentCommand = undefined;
                        nativeTurnOpen = false;
                        start(message, true);
                        enqueue(
                            assistant(
                                [{ type: 'text', text: 'separate turn' }],
                                'end_turn',
                                sessionId()
                            )
                        );
                        enqueue(result(undefined, undefined, sessionId()));
                        const uuid = string(message.uuid);
                        if (uuid) lifecycle(uuid, 'completed');
                        currentCommand = undefined;
                        nativeTurnOpen = false;
                        return;
                    }
                    if (
                        message?.type === 'user' &&
                        this.scenario === 'queued_steering' &&
                        currentCommand
                    ) {
                        queue(message);
                        return;
                    }
                    if (
                        message?.type === 'user' &&
                        this.scenario === 'steering' &&
                        currentCommand
                    ) {
                        queue(message);
                        enqueue(toolResult());
                        enqueue({
                            ...message,
                            session_id: sessionId(),
                            isReplay: true,
                        });
                        const uuid = string(message.uuid);
                        if (uuid) {
                            lifecycle(uuid, 'started');
                            foldedCommands.add(uuid);
                        }
                        return;
                    }
                    if (message?.type === 'user') {
                        queue(message);
                        start(message, true);
                    }
                    if (
                        message?.type === 'user' &&
                        input.length === 1 &&
                        (this.scenario === 'steering' ||
                            this.scenario === 'separate_steering')
                    ) {
                        enqueue(toolUse());
                        return;
                    }
                    if (
                        message?.type === 'user' &&
                        input.length === 1 &&
                        this.scenario === 'held_steering'
                    ) {
                        setTimeout(finish, 0);
                        return;
                    }
                    if (
                        message?.type === 'control_request' &&
                        record(message.request)?.subtype === 'interrupt' &&
                        this.scenario !== 'ignore_sigterm'
                    ) {
                        const queued = input
                            .map(parseLine)
                            .filter((entry) => entry?.type === 'user')
                            .flatMap((entry) => {
                                const uuid = string(entry?.uuid);
                                return uuid && uuid !== currentCommand ? [uuid] : [];
                            });
                        for (const uuid of queued) lifecycle(uuid, 'cancelled');
                        enqueue({
                            ...claudeProtocolFixture('interrupt-response.json'),
                            response: {
                                ...record(
                                    claudeProtocolFixture('interrupt-response.json')
                                        .response
                                ),
                                request_id: message.request_id,
                                ...(this.scenario === 'queued_steering'
                                    ? {
                                          response: {
                                              still_queued: [],
                                              cancelled: queued,
                                          },
                                      }
                                    : {}),
                            },
                        });
                        enqueue(errorResult(sessionId()));
                        for (const uuid of foldedCommands) {
                            lifecycle(uuid, 'cancelled');
                        }
                        foldedCommands.clear();
                        if (currentCommand) lifecycle(currentCommand, 'cancelled');
                        currentCommand = undefined;
                        nativeTurnOpen = false;
                        return;
                    }
                    if (message?.type === 'control_response') {
                        if (this.scenario === 'control_request') finish();
                        if (this.scenario === 'permissions') {
                            const response = record(message.response);
                            if (
                                record(response?.response)?.behavior !== 'allow' ||
                                response?.request_id !== 'permission_contract'
                            ) {
                                throw new Error(
                                    'Unexpected contract permission response'
                                );
                            }
                            finish();
                        }
                        if (this.scenario === 'permission_allow') {
                            expectResponse(message, 'permission-allow-response.json');
                            finish();
                        }
                        if (this.scenario === 'permission_deny') {
                            expectResponse(message, 'permission-deny-response.json');
                            finish();
                        }
                        if (this.scenario === 'between_turn_request') {
                            expectResponse(message, 'permission-allow-response.json');
                        }
                        if (this.scenario === 'permission_always') {
                            const responseCount = input.filter((entry) =>
                                entry.includes('"type":"control_response"')
                            ).length;
                            expectResponse(
                                message,
                                responseCount === 1
                                    ? 'permission-always-response.json'
                                    : 'permission-cached-response.json'
                            );
                            if (responseCount === 1) {
                                const request = claudeProtocolFixture(
                                    'permission-request.json'
                                );
                                request.request_id = 'permission_contract_2';
                                controller?.enqueue(
                                    new TextEncoder().encode(
                                        `${JSON.stringify(request)}\n`
                                    )
                                );
                            } else {
                                finish();
                            }
                        }
                        if (
                            this.scenario === 'questions' ||
                            this.scenario === 'questions_multiple'
                        ) {
                            if (this.scenario === 'questions_multiple') {
                                expectResponse(message, 'question-response.json');
                            }
                            finish();
                        }
                        if (this.scenario === 'question_reject') {
                            expectResponse(message, 'question-reject-response.json');
                            finish();
                        }
                        return;
                    }
                    if (this.scenario === 'exit_without_result') {
                        settled = true;
                        controller?.close();
                        exit?.(1);
                        return;
                    }
                    if (this.scenario === 'control_request') {
                        controller?.enqueue(
                            new TextEncoder().encode(
                                `${JSON.stringify({
                                    type: 'control_request',
                                    request_id: 'request-1',
                                    request: { subtype: 'future_request' },
                                })}\n`
                            )
                        );
                        return;
                    }
                    if (this.scenario === 'cancelled_request') {
                        enqueue(claudeProtocolFixture('permission-request.json'));
                        enqueue({
                            type: 'control_cancel_request',
                            request_id: 'permission_contract_1',
                        });
                        finish();
                        return;
                    }
                    if (this.scenario === 'between_turn_request') {
                        finish();
                        enqueue(claudeProtocolFixture('permission-request.json'));
                        return;
                    }
                    if (this.scenario === 'control_plane') {
                        enqueue({ type: 'keep_alive' });
                        enqueue({
                            type: 'control_response',
                            response: {
                                subtype: 'success',
                                request_id: 'unknown-control',
                                response: {},
                            },
                        });
                        finish();
                        return;
                    }
                    if (this.scenario === 'background_turn') {
                        finish();
                        enqueue({ type: 'rate_limit_event' });
                        for (const subtype of [
                            'thinking_tokens',
                            'hook_started',
                            'hook_response',
                            'task_started',
                            'task_updated',
                        ]) {
                            enqueue({
                                type: 'system',
                                subtype,
                                session_id: sessionId(),
                            });
                        }
                        enqueue({
                            type: 'system',
                            subtype: 'task_notification',
                            session_id: sessionId(),
                        });
                        enqueue({
                            type: 'system',
                            subtype: 'background_tasks_changed',
                            session_id: sessionId(),
                        });
                        enqueue({
                            type: 'system',
                            subtype: 'init',
                            session_id: sessionId(),
                        });
                        enqueue(
                            assistant(
                                [{ type: 'text', text: 'background activity' }],
                                'end_turn',
                                sessionId()
                            )
                        );
                        enqueue(result(undefined, undefined, sessionId()));
                        return;
                    }
                    if (
                        this.scenario === 'permission_allow' ||
                        this.scenario === 'permission_deny' ||
                        this.scenario === 'permission_always' ||
                        this.scenario === 'pending_request' ||
                        this.scenario === 'asynchronous_write_failure'
                    ) {
                        controller?.enqueue(
                            new TextEncoder().encode(
                                `${JSON.stringify(
                                    claudeProtocolFixture('permission-request.json')
                                )}\n`
                            )
                        );
                        return;
                    }
                    if (this.scenario === 'permissions') {
                        enqueue({
                            type: 'control_request',
                            request_id: 'permission_contract',
                            request: {
                                subtype: 'can_use_tool',
                                tool_name: 'external_directory',
                                input: { path: '/outside/*' },
                            },
                        });
                        return;
                    }
                    if (
                        this.scenario === 'questions' ||
                        this.scenario === 'questions_multiple' ||
                        this.scenario === 'question_reject'
                    ) {
                        const request = claudeProtocolFixture('question-request.json');
                        if (this.scenario === 'questions') {
                            const native = record(request.request);
                            const nativeInput = record(native?.input);
                            const questions = Array.isArray(nativeInput?.questions)
                                ? nativeInput.questions.slice(0, 1).map((question) => {
                                      const value = record(question);
                                      return {
                                          question: value?.question,
                                          options: records(value?.options).map(
                                              (option) => ({
                                                  label: option.label,
                                              })
                                          ),
                                          multiSelect: false,
                                          custom: false,
                                      };
                                  })
                                : [];
                            request.request = {
                                ...native,
                                input: {
                                    ...nativeInput,
                                    questions,
                                },
                            };
                        }
                        controller?.enqueue(
                            new TextEncoder().encode(`${JSON.stringify(request)}\n`)
                        );
                        return;
                    }
                    if (this.scenario === 'malformed_stream') {
                        controller?.enqueue(new TextEncoder().encode('not-json\n'));
                    } else if (this.scenario === 'stray_result' && input.length === 2) {
                        finish();
                    } else if (
                        this.scenario !== 'cancellation' &&
                        this.scenario !== 'steering' &&
                        this.scenario !== 'separate_steering' &&
                        this.scenario !== 'queued_steering' &&
                        this.scenario !== 'ignore_sigterm' &&
                        this.scenario !== 'events_after_cancel'
                    ) {
                        finish();
                    }
                },
                end: () => {},
            },
            stdout,
            stderr: new ReadableStream<Uint8Array>({
                start(value) {
                    if (scenario === 'exit_without_result') {
                        value.enqueue(
                            new TextEncoder().encode(
                                `bundled source excerpt\nerror: native startup failed ${invocation.env.ANTHROPIC_API_KEY ?? ''}\ntrailing diagnostic`
                            )
                        );
                    }
                    value.close();
                },
            }),
            kill:
                scenario === 'exit_without_result'
                    ? () => {
                          throw new Error('cannot signal an exited process');
                      }
                    : cancel,
        };
    };

    private events(input: string[]): unknown[] {
        const current = input.at(-1) ?? '';
        const prompt = current.includes('second') ? 'second' : 'first';
        const sessionId =
            invocationValue(this.invocations.at(-1)?.command ?? [], '--session-id') ??
            invocationValue(this.invocations.at(-1)?.command ?? [], '--resume') ??
            'claude-contract-session';
        if (this.scenario === 'failures') {
            return [
                {
                    type: 'result',
                    subtype: 'error_during_execution',
                    is_error: true,
                    session_id: sessionId,
                    usage: {},
                },
            ];
        }
        if (this.scenario === 'unknown_events') {
            return [
                { type: 'future.event', secret: 'MUST_NOT_RENDER_CREDENTIAL' },
                result(undefined, undefined, sessionId),
            ];
        }
        if (this.scenario === 'tool_events') {
            return [
                assistant(
                    [
                        {
                            type: 'tool_use',
                            id: 'call_contract',
                            name: 'write',
                            input: {
                                file_path: '/workspace/output.txt',
                                content: 'MUST_NOT_RENDER_TOOL_OUTPUT',
                            },
                        },
                    ],
                    null,
                    sessionId
                ),
                {
                    type: 'user',
                    session_id: sessionId,
                    message: {
                        role: 'user',
                        content: [
                            {
                                type: 'tool_result',
                                tool_use_id: 'call_contract',
                                content: 'MUST_NOT_RENDER_TOOL_OUTPUT',
                            },
                        ],
                    },
                },
                result({ input_tokens: 5, output_tokens: 7 }, 0.001, sessionId),
            ];
        }
        if (this.scenario === 'multi_turn' || this.scenario === 'stray_result') {
            return [
                assistant([{ type: 'text', text: prompt }], 'end_turn', sessionId),
                result(undefined, undefined, sessionId),
            ];
        }
        return [
            assistant([{ type: 'text', text: 'Hello' }], null, sessionId),
            assistant([{ type: 'text', text: ' world' }], 'end_turn', sessionId),
            result(undefined, undefined, sessionId),
        ];
    }
}

function parseLine(value: string | Uint8Array): Record<string, unknown> | undefined {
    try {
        return record(JSON.parse(String(value)));
    } catch {
        return undefined;
    }
}

function expectResponse(message: Record<string, unknown>, fixture: string): void {
    const expected = claudeProtocolFixture(fixture);
    if (JSON.stringify(message) !== JSON.stringify(expected)) {
        throw new Error(
            `Unexpected Claude response: ${JSON.stringify(message)} expected ${JSON.stringify(expected)}`
        );
    }
}

function record(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value))
        : undefined;
}

function string(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function records(value: unknown): Record<string, unknown>[] {
    return Array.isArray(value)
        ? value.flatMap((entry) => {
              const found = record(entry);
              return found ? [found] : [];
          })
        : [];
}

export function claudeProtocolFixture(name: string): Record<string, unknown> {
    const value: unknown = JSON.parse(
        readFileSync(
            join(import.meta.dir, '..', '..', 'fixtures', 'claude-code', name),
            'utf8'
        )
    );
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`Invalid Claude protocol fixture: ${name}`);
    }
    return Object.fromEntries(Object.entries(value));
}

export function claudeProtocolTrace(name: string): unknown[] {
    return readFileSync(
        join(import.meta.dir, '..', '..', 'fixtures', 'claude-code', name),
        'utf8'
    )
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as unknown);
}

function assistant(
    content: unknown[],
    stopReason: string | null = null,
    sessionId = 'claude-contract-session'
) {
    return {
        type: 'assistant',
        session_id: sessionId,
        message: {
            id: `msg-${crypto.randomUUID()}`,
            role: 'assistant',
            content,
            stop_reason: stopReason,
        },
    };
}

function result(
    usage = { input_tokens: 0, output_tokens: 0 },
    cost = 0,
    sessionId = 'claude-contract-session'
) {
    return {
        type: 'result',
        subtype: 'success',
        is_error: false,
        session_id: sessionId,
        total_cost_usd: cost,
        usage,
    };
}

function errorResult(sessionId: string) {
    return {
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        session_id: sessionId,
        usage: {},
    };
}

function toolUse() {
    return assistant([
        {
            type: 'tool_use',
            id: 'tool-steering',
            name: 'Bash',
            input: { command: 'fixture command' },
        },
    ]);
}

function toolResult() {
    return {
        type: 'user',
        message: {
            role: 'user',
            content: [
                {
                    type: 'tool_result',
                    tool_use_id: 'tool-steering',
                    content: 'complete',
                },
            ],
        },
    };
}

function invocationValue(command: string[], flag: string): string | undefined {
    const index = command.indexOf(flag);
    return index >= 0 ? command[index + 1] : undefined;
}
