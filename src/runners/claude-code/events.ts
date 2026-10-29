import type { WorkbenchEventDraft } from '../../runs/events.js';
import { resultText, ToolDetails } from '../details.js';
import type { RunnerEventNormalizer, RunnerSummary } from '../runner.js';
import { completionReason } from '../session.js';
import { describeTool, type ToolDescription } from '../tool.js';
import { claudeCodeMcp, claudeCodePatch } from './changes.js';
import { ClaudeCodeCost } from './cost.js';

export interface ClaudeCodeEventResult {
    events: WorkbenchEventDraft[];
}

/** Native types that carry nothing a Workbench client needs. */
const QUIET_TYPES = new Set([
    'rate_limit_event',
    'keep_alive',
    'command_lifecycle',
    'control_request',
    'control_response',
    'control_cancel_request',
]);

const QUIET_SYSTEM_SUBTYPES = new Set([
    'init',
    'thinking_tokens',
    'hook_started',
    'hook_response',
    'task_started',
    'task_updated',
    'task_notification',
    'background_tasks_changed',
]);

/** The file operation each Claude Code editing tool performs. */
const FILE_OPERATIONS = new Map([
    ['write', 'write'],
    ['edit', 'edit'],
    ['multiedit', 'edit'],
    ['notebookedit', 'edit'],
]);

const FAILURE_PREFIX = 'Claude Code session failed';

/**
 * Normalizes Claude Code's stream-json output for one process. Tool state and
 * the cost baseline span the process; the reply summary covers the
 * turn begun last. Only output that belongs to the host's turn is its reply:
 * subagent text and background turns never are.
 */
export class ClaudeCodeEventAdapter implements RunnerEventNormalizer {
    private readonly tools = new Map<
        string,
        {
            name: string;
            description: ToolDescription;
            target: string | undefined;
            input: Record<string, unknown> | undefined;
        }
    >();
    private readonly details: ToolDetails;
    private readonly completedTools = new Set<string>();
    private messageId: string | undefined;
    private outputId: string | undefined;
    private readonly cost: ClaudeCodeCost;
    private finalText = '';
    private turnCompleted = false;
    private reason: string | undefined;
    private failure: string | undefined;

    /**
     * `cost` turns the session's cumulative total into per-turn costs;
     * `details` scrubs and bounds tool arguments, results, and patches.
     */
    constructor(options: { cost?: ClaudeCodeCost; details?: ToolDetails } = {}) {
        this.cost = options.cost ?? ClaudeCodeCost.fresh();
        this.details = options.details ?? new ToolDetails();
    }

    beginTurn(): void {
        this.finalText = '';
        this.turnCompleted = false;
        this.reason = undefined;
        this.failure = undefined;
    }

    consume(value: unknown, reply = true): ClaudeCodeEventResult {
        const event = record(value);
        if (!event) return marker('malformed');
        const type = string(event.type);
        if (!type) return marker('unknown');
        if (QUIET_TYPES.has(type)) return { events: [] };
        if (type === 'assistant') return this.assistant(event, reply);
        if (type === 'user') return this.user(event);
        if (type === 'result') return this.result(event, reply);
        if (type === 'system') {
            const subtype = string(event.subtype) ?? 'unknown';
            return QUIET_SYSTEM_SUBTYPES.has(subtype)
                ? { events: [] }
                : marker(`system.${subtype}`);
        }
        return marker(type);
    }

    summary(): RunnerSummary {
        return {
            finalText: this.finalText,
            turnCompleted: this.turnCompleted,
            ...(this.reason ? { completionReason: this.reason } : {}),
            ...(this.failure ? { failureMessage: failureMessage([this.failure]) } : {}),
        };
    }

    /** What the native result said went wrong in the turn, unredacted. */
    failureDetail(): string | undefined {
        return this.failure;
    }

    private assistant(
        event: Record<string, unknown>,
        reply: boolean
    ): ClaudeCodeEventResult {
        const message = record(event.message);
        const main = !string(event.parent_tool_use_id);
        const events: WorkbenchEventDraft[] = [];
        for (const block of blocks(message?.content)) {
            const kind = string(block.type);
            if (kind === 'text' && main && reply) {
                const text = string(block.text);
                if (!text) continue;
                const messageId = string(message?.id) ?? 'unknown';
                if (!this.outputId || messageId !== this.messageId) {
                    this.messageId = messageId;
                    this.outputId = `output_${crypto.randomUUID()}`;
                }
                this.finalText += text;
                events.push({ type: 'output.text', data: { id: this.outputId, text } });
            } else if (kind === 'tool_use') {
                events.push(...this.toolStarted(block));
            }
        }
        return { events };
    }

    private user(event: Record<string, unknown>): ClaudeCodeEventResult {
        const events: WorkbenchEventDraft[] = [];
        const results = blocks(record(event.message)?.content).filter(
            (block) => string(block.type) === 'tool_result'
        );
        // The structured result describes the message's only tool result.
        const structured =
            results.length === 1 ? record(event.tool_use_result) : undefined;
        for (const block of results) {
            events.push(...this.toolCompleted(block, structured));
        }
        return { events };
    }

    private toolStarted(block: Record<string, unknown>): WorkbenchEventDraft[] {
        const id = string(block.id);
        if (!id || this.tools.has(id)) return [];
        const name = string(block.name) ?? 'tool';
        const native = record(block.input);
        const input = toolInput(native);
        const description = describeTool(name, input, undefined);
        this.tools.set(id, {
            name,
            description,
            target: string(input?.filePath),
            input: native,
        });
        return [
            {
                type: 'tool.started',
                data: {
                    id,
                    name,
                    ...this.identity(name, description),
                    ...this.details.input(name, native),
                },
            },
        ];
    }

    /** The tool's description, and its MCP server and tool when it is an MCP tool. */
    private identity(name: string, description: ToolDescription) {
        const mcp = claudeCodeMcp(name);
        return { ...description, ...(mcp ? { mcp } : {}) };
    }

    private toolCompleted(
        block: Record<string, unknown>,
        structured: Record<string, unknown> | undefined
    ): WorkbenchEventDraft[] {
        const id = string(block.tool_use_id);
        if (!id || this.completedTools.has(id)) return [];
        this.completedTools.add(id);
        const tool = this.tools.get(id);
        const name = tool?.name ?? 'tool';
        const description =
            tool?.description ?? describeTool(name, undefined, undefined);
        const failed = block.is_error === true;
        const identity = this.identity(name, description);
        const events: WorkbenchEventDraft[] = [];
        if (!tool) {
            events.push({ type: 'tool.started', data: { id, name, ...identity } });
        }
        events.push({
            type: 'tool.completed',
            data: {
                id,
                name,
                ...identity,
                status: failed ? 'failed' : 'completed',
                ...(failed
                    ? { error_code: 'runner_error', message: 'Tool failed in runner' }
                    : {}),
                ...this.details.input(name, tool?.input),
                ...this.details.output(resultText(block.content)),
            },
        });
        const operation = FILE_OPERATIONS.get(name.toLowerCase());
        if (!failed && operation && tool?.target) {
            events.push({
                type: 'file.changed',
                data: {
                    path: tool.target,
                    operation,
                    ...claudeCodePatch(
                        this.details,
                        name,
                        tool.target,
                        tool.input,
                        structured
                    ),
                },
            });
        }
        return events;
    }

    private result(
        event: Record<string, unknown>,
        reply: boolean
    ): ClaudeCodeEventResult {
        const events: WorkbenchEventDraft[] = [];
        const usage = this.usage(event);
        if (usage) events.push({ type: 'usage.updated', data: usage });
        if (!reply) return { events };
        this.turnCompleted = true;
        if (event.is_error === true) {
            this.failure = resultFailure(event);
            return { events };
        }
        this.reason = completionReason(string(event.stop_reason) ?? 'completed');
        events.push({ type: 'turn.completed', data: { reason: this.reason } });
        return { events };
    }

    private usage(event: Record<string, unknown>): Record<string, unknown> | undefined {
        const usage = record(event.usage);
        const input = number(usage?.input_tokens);
        const output = number(usage?.output_tokens);
        const cacheRead = number(usage?.cache_read_input_tokens);
        const cacheWrite = number(usage?.cache_creation_input_tokens);
        const cost = this.cost.delta(number(event.total_cost_usd));
        const tokens = [input, output, cacheRead, cacheWrite].filter(
            (value): value is number => value !== undefined
        );
        const data = compact({
            kind: 'delta',
            total_tokens:
                tokens.length > 0
                    ? tokens.reduce((sum, value) => sum + value, 0)
                    : undefined,
            input_tokens: input,
            output_tokens: output,
            cache_read_tokens: cacheRead,
            cache_write_tokens: cacheWrite,
            cost_usd: cost,
        });
        return Object.keys(data).length > 1 ? data : undefined;
    }
}

/**
 * A safe failure message. Details are joined in order, credentials the caller
 * names and long token-like strings are redacted, and the result is bounded.
 */
export function failureMessage(
    details: Array<string | undefined>,
    secrets: Iterable<string> = []
): string {
    let detail = details
        .filter((value): value is string => Boolean(value?.trim()))
        .join(' ')
        .replaceAll(/\s+/gu, ' ')
        .trim();
    for (const secret of [...secrets]
        .filter((value) => value.length >= 4)
        .toSorted((left, right) => right.length - left.length)) {
        detail = detail.replaceAll(secret, '[redacted]');
    }
    detail = detail.replaceAll(/[A-Za-z0-9_\-.+/=]{24,}/gu, '[redacted]');
    return detail ? `${FAILURE_PREFIX}: ${detail.slice(0, 300)}` : FAILURE_PREFIX;
}

function resultFailure(event: Record<string, unknown>): string {
    const errors = Array.isArray(event.errors)
        ? event.errors.filter((value): value is string => typeof value === 'string')
        : [];
    return (
        string(event.result) ??
        errors[0] ??
        string(event.subtype) ??
        'Claude Code reported an error'
    );
}

/** Claude Code names file paths `file_path` and `notebook_path`. */
function toolInput(input: Record<string, unknown> | undefined) {
    if (!input) return undefined;
    const path = string(input.file_path) ?? string(input.notebook_path);
    return path ? { ...input, filePath: path } : input;
}

function marker(nativeType: string): ClaudeCodeEventResult {
    return {
        events: [
            {
                type: 'runner.event',
                data: {
                    native_type: /^[\w.:/-]{1,64}$/u.test(nativeType)
                        ? nativeType
                        : 'unknown',
                },
            },
        ],
    };
}

function blocks(content: unknown): Record<string, unknown>[] {
    if (!Array.isArray(content)) return [];
    return content.flatMap((block) => {
        const value = record(block);
        return value ? [value] : [];
    });
}

function compact(value: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(
        Object.entries(value).filter((entry) => entry[1] !== undefined)
    );
}

export function record(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
}

export function string(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function number(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
