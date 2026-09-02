import type { WorkbenchEventDraft } from '../../runs/index.js';

export interface PiAdapterResult {
    events: WorkbenchEventDraft[];
    turnCompleted: boolean;
}

export class PiEventAdapter {
    private readonly startedTools = new Set<string>();
    private readonly completedTools = new Set<string>();
    private readonly tools = new Map<
        string,
        { name: string; target: string | undefined }
    >();
    private turnCompleted = false;
    private finalText = '';
    private sessionId: string | undefined;
    private completionReason: string | undefined;
    private failureMessage: string | undefined;
    private outputId: string | undefined;

    consume(value: unknown): PiAdapterResult {
        const event = record(value);
        if (!event) return this.native('malformed');
        const type = string(event.type);
        if (!type) return this.native('unknown');

        if (type === 'session') {
            this.sessionId ??= string(event.id);
            return this.result([]);
        }
        if (type === 'message_start') return this.messageStart(event);
        if (type === 'message_update') return this.messageUpdate(event);
        if (type === 'message_end') return this.messageEnd(event);
        if (type === 'tool_execution_start') return this.toolStart(event);
        if (type === 'tool_execution_update') return this.result([]);
        if (type === 'tool_execution_end') return this.toolEnd(event);
        if (type === 'turn_end') {
            this.turnCompleted = true;
            this.completionReason = messageReason(record(event.message)) ?? 'completed';
            return this.result([
                {
                    type: 'turn.completed',
                    data: { reason: this.completionReason },
                },
            ]);
        }
        if (type === 'agent_end' || type === 'agent_start' || type === 'turn_start') {
            return this.result([]);
        }
        if (type === 'extension_error') {
            this.failureMessage ??= 'Pi extension failed';
            return this.result([
                {
                    type: 'runner.event',
                    data: { native_type: type, status: 'error' },
                },
            ]);
        }
        return this.native(type);
    }

    summary() {
        return {
            finalText: this.finalText,
            turnCompleted: this.turnCompleted,
            ...(this.sessionId ? { sessionId: this.sessionId } : {}),
            ...(this.completionReason
                ? { completionReason: this.completionReason }
                : {}),
            ...(this.failureMessage ? { failureMessage: this.failureMessage } : {}),
        };
    }

    private messageUpdate(event: Record<string, unknown>): PiAdapterResult {
        const update = record(event.assistantMessageEvent);
        if (string(update?.type) !== 'text_delta') return this.result([]);
        const text = string(update?.delta);
        if (!text) return this.result([]);
        this.finalText += text;
        this.outputId ??= createOutputId();
        return this.result([
            { type: 'output.text', data: { id: this.outputId, text } },
        ]);
    }

    private messageStart(event: Record<string, unknown>): PiAdapterResult {
        if (string(record(event.message)?.role) === 'assistant') {
            this.outputId = createOutputId();
        }
        return this.result([]);
    }

    private messageEnd(event: Record<string, unknown>): PiAdapterResult {
        const message = record(event.message);
        if (string(message?.role) !== 'assistant') return this.result([]);
        const usage = record(message?.usage);
        const data = usageData(usage);
        const reason = messageReason(message);
        if (reason === 'error' || reason === 'aborted') {
            this.failureMessage ??=
                reason === 'aborted' ? 'Pi turn was aborted' : 'Pi session failed';
        }
        const result = this.result(
            Object.keys(data).length > 1 ? [{ type: 'usage.updated', data }] : []
        );
        this.outputId = undefined;
        return result;
    }

    private toolStart(event: Record<string, unknown>): PiAdapterResult {
        const id = string(event.toolCallId) ?? 'unknown';
        if (this.startedTools.has(id)) return this.result([]);
        this.startedTools.add(id);
        const name = string(event.toolName) ?? 'tool';
        const target = toolTarget(record(event.args));
        this.tools.set(id, { name, target });
        return this.result([
            {
                type: 'tool.started',
                data: { id, name, ...(target ? { target } : {}) },
            },
        ]);
    }

    private toolEnd(event: Record<string, unknown>): PiAdapterResult {
        const id = string(event.toolCallId) ?? 'unknown';
        const started = this.tools.get(id);
        const name = string(event.toolName) ?? started?.name ?? 'tool';
        const target = toolTarget(record(event.args)) ?? started?.target;
        const events: WorkbenchEventDraft[] = [];
        if (!this.startedTools.has(id)) {
            this.startedTools.add(id);
            events.push({
                type: 'tool.started',
                data: { id, name, ...(target ? { target } : {}) },
            });
        }
        if (!this.completedTools.has(id)) {
            this.completedTools.add(id);
            const failed = event.isError === true;
            events.push({
                type: 'tool.completed',
                data: {
                    id,
                    name,
                    ...(target ? { target } : {}),
                    status: failed ? 'failed' : 'completed',
                    ...(failed
                        ? {
                              error_code: 'runner_error',
                              message: 'Tool failed in runner',
                          }
                        : {}),
                },
            });
            const changed = changedFile(name, target);
            if (!failed && changed) {
                events.push({ type: 'file.changed', data: changed });
            }
        }
        return this.result(events);
    }

    private native(nativeType: string): PiAdapterResult {
        return this.result([
            { type: 'runner.event', data: { native_type: nativeType } },
        ]);
    }

    private result(events: WorkbenchEventDraft[]): PiAdapterResult {
        return { events, turnCompleted: this.turnCompleted };
    }
}

function createOutputId(): string {
    return `output_${crypto.randomUUID()}`;
}

function usageData(usage: Record<string, unknown> | undefined) {
    const cost = record(usage?.cost);
    return compact({
        kind: 'delta',
        total_tokens: number(usage?.totalTokens),
        input_tokens: number(usage?.input),
        output_tokens: number(usage?.output),
        cache_read_tokens: number(usage?.cacheRead),
        cache_write_tokens: number(usage?.cacheWrite),
        cost_usd: number(cost?.total),
    });
}

function messageReason(message: Record<string, unknown> | undefined) {
    return string(message?.stopReason) ?? string(message?.reason);
}

function toolTarget(input: Record<string, unknown> | undefined): string | undefined {
    if (!input) return undefined;
    for (const key of ['path', 'filePath']) {
        const value = string(input[key]);
        if (value) return value.length > 240 ? `${value.slice(0, 237)}...` : value;
    }
    return undefined;
}

function changedFile(name: string, target: string | undefined) {
    if (!target) return undefined;
    const operation = new Map([
        ['write', 'write'],
        ['edit', 'edit'],
        ['patch', 'edit'],
        ['apply_patch', 'edit'],
    ]).get(name.toLowerCase());
    return operation ? { path: target, operation } : undefined;
}

function compact(value: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(
        Object.entries(value).filter((entry) => entry[1] !== undefined)
    );
}

function record(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
}

function string(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function number(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
