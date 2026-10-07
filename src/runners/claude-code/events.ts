import type { WorkbenchEventDraft } from '../../runs/events.js';
import { describeTool, type ToolDescription } from '../tool.js';

export interface ClaudeCodeAdapterResult {
    events: WorkbenchEventDraft[];
    terminal: boolean;
}

export class ClaudeCodeEventAdapter {
    private readonly tools = new Map<
        string,
        { name: string; description: ToolDescription }
    >();
    private finalText = '';
    private sessionId: string | undefined;
    private completionReason: string | undefined;
    private failureMessage: string | undefined;
    private terminal = false;
    constructor(
        private previousTotalCost = 0,
        private readonly reportNativeCost = true
    ) {}

    get totalCost(): number {
        return this.previousTotalCost;
    }

    consume(value: unknown): ClaudeCodeAdapterResult {
        const event = record(value);
        if (!event) return this.native('malformed');
        const type = string(event.type);
        if (!type) return this.native('unknown');
        this.sessionId ??= string(event.session_id);
        if (type === 'system' && event.subtype === 'init') return this.result([]);
        if (type === 'assistant') return this.assistant(event);
        if (type === 'user') return this.user(event);
        if (type === 'result') return this.finish(event);
        if (type === 'stream_event') return this.result([]);
        return this.native(type);
    }

    summary() {
        return {
            finalText: this.finalText,
            turnCompleted: this.terminal && !this.failureMessage,
            ...(this.sessionId ? { sessionId: this.sessionId } : {}),
            ...(this.completionReason
                ? { completionReason: this.completionReason }
                : {}),
            ...(this.failureMessage ? { failureMessage: this.failureMessage } : {}),
        };
    }

    private assistant(event: Record<string, unknown>): ClaudeCodeAdapterResult {
        const message = record(event.message);
        const parentToolUseId = string(event.parent_tool_use_id);
        const subagent = Boolean(parentToolUseId);
        const outputId = string(message?.id) ?? `output_${crypto.randomUUID()}`;
        const events: WorkbenchEventDraft[] = [];
        for (const block of records(message?.content)) {
            if (block.type === 'text' && !subagent) {
                const text = string(block.text);
                if (text) {
                    this.finalText += text;
                    events.push({ type: 'output.text', data: { id: outputId, text } });
                }
            }
            if (block.type === 'tool_use') {
                const id = string(block.id) ?? 'unknown';
                const name = string(block.name) ?? 'tool';
                const described = describeTool(
                    name,
                    claudeToolInput(record(block.input)),
                    undefined
                );
                const description = parentToolUseId
                    ? {
                          ...described,
                          description: `Subagent activity under ${parentToolUseId}`,
                      }
                    : described;
                this.tools.set(id, { name, description });
                events.push({
                    type: 'tool.started',
                    data: { id, name, ...description },
                });
            }
        }
        const stopReason = string(message?.stop_reason);
        if (!subagent && stopReason && stopReason !== 'tool_use') {
            this.completionReason = stopReason === 'max_tokens' ? 'length' : stopReason;
        }
        return this.result(events);
    }

    private user(event: Record<string, unknown>): ClaudeCodeAdapterResult {
        const message = record(event.message);
        const events: WorkbenchEventDraft[] = [];
        for (const block of records(message?.content)) {
            if (block.type !== 'tool_result') continue;
            const id = string(block.tool_use_id) ?? 'unknown';
            const tool = this.tools.get(id);
            const name = tool?.name ?? 'tool';
            const description =
                tool?.description ?? describeTool(name, undefined, undefined);
            const failed = block.is_error === true;
            events.push({
                type: 'tool.completed',
                data: {
                    id,
                    name,
                    ...description,
                    status: failed ? 'failed' : 'completed',
                    ...(failed
                        ? {
                              error_code: 'runner_error',
                              message: 'Tool failed in runner',
                          }
                        : {}),
                },
            });
            const changed = changedFile(name, description.target);
            if (!failed && changed) {
                events.push({ type: 'file.changed', data: changed });
            }
        }
        return this.result(events);
    }

    private finish(event: Record<string, unknown>): ClaudeCodeAdapterResult {
        this.terminal = true;
        const stopReason = string(event.stop_reason);
        if (stopReason) {
            this.completionReason = stopReason === 'max_tokens' ? 'length' : stopReason;
        }
        const usage = record(event.usage);
        const input = number(usage?.input_tokens) ?? 0;
        const output = number(usage?.output_tokens) ?? 0;
        const cacheRead = number(usage?.cache_read_input_tokens) ?? 0;
        const cacheWrite = number(usage?.cache_creation_input_tokens) ?? 0;
        const cumulativeCost = number(event.total_cost_usd);
        const nativeCost =
            cumulativeCost === undefined
                ? undefined
                : Math.max(0, cumulativeCost - this.previousTotalCost);
        const cost =
            nativeCost === undefined
                ? undefined
                : this.reportNativeCost
                  ? nativeCost
                  : 0;
        if (cumulativeCost !== undefined) this.previousTotalCost = cumulativeCost;
        const events: WorkbenchEventDraft[] = [
            {
                type: 'usage.updated',
                data: {
                    kind: 'delta',
                    total_tokens: input + output + cacheRead + cacheWrite,
                    input_tokens: input,
                    output_tokens: output,
                    cache_read_tokens: cacheRead,
                    cache_write_tokens: cacheWrite,
                    ...(cost !== undefined ? { cost_usd: cost } : {}),
                },
            },
        ];
        if (event.is_error === true || string(event.subtype) !== 'success') {
            this.failureMessage = safeFailure(event);
            return this.result(events);
        }
        const reason = this.completionReason ?? 'completed';
        events.push({ type: 'turn.completed', data: { reason } });
        return this.result(events);
    }

    private native(nativeType: string): ClaudeCodeAdapterResult {
        return this.result([
            { type: 'runner.event', data: { native_type: nativeType } },
        ]);
    }

    private result(events: WorkbenchEventDraft[]): ClaudeCodeAdapterResult {
        return { events, terminal: this.terminal };
    }
}

function safeFailure(event: Record<string, unknown>): string {
    const result = string(event.result);
    if (event.is_error === true && result) return result;
    const subtype = string(event.subtype);
    if (subtype === 'error_max_turns') return 'Claude Code reached its maximum turns';
    if (subtype === 'error_max_budget_usd') return 'Claude Code reached its cost limit';
    const details = Array.isArray(event.errors)
        ? event.errors.filter((value): value is string => typeof value === 'string')
        : [];
    const kind = subtype ? ` (${subtype})` : '';
    const suffix = details.length > 0 ? `: ${details.join('; ')}` : '';
    return `Claude Code session failed${kind}${suffix}`;
}

function changedFile(name: string, target: string | undefined) {
    if (!target) return undefined;
    const operation = new Map([
        ['write', 'write'],
        ['edit', 'edit'],
        ['multiedit', 'edit'],
        ['notebookedit', 'edit'],
    ]).get(name.toLowerCase());
    return operation ? { path: target, operation } : undefined;
}

function claudeToolInput(
    input: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
    if (!input) return input;
    if (input.file_path !== undefined) return { ...input, filePath: input.file_path };
    if (input.notebook_path !== undefined) {
        return { ...input, filePath: input.notebook_path };
    }
    return input;
}

function records(value: unknown): Record<string, unknown>[] {
    return Array.isArray(value)
        ? value.flatMap((entry) => {
              const found = record(entry);
              return found ? [found] : [];
          })
        : [];
}

function record(value: unknown): Record<string, unknown> | undefined {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return undefined;
    }
    return Object.fromEntries(Object.entries(value));
}

function string(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function number(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
