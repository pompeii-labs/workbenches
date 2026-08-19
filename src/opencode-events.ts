import type { WorkbenchEventType } from './execution.js';

export interface EventDraft {
    type: WorkbenchEventType;
    data: Record<string, unknown>;
}

export interface OpenCodeAdapterResult {
    events: EventDraft[];
    finalText?: string;
    turnCompleted: boolean;
}

export class OpenCodeEventAdapter {
    private readonly startedTools = new Set<string>();
    private turnCompleted = false;
    private finalText = '';

    consume(value: unknown): OpenCodeAdapterResult {
        const event = record(value);
        if (!event) return this.native('malformed');
        const type = string(event.type);
        if (!type) return this.native('unknown');

        if (type === 'step_start') return this.result([]);
        if (type === 'text') return this.text(event);
        if (type === 'tool_use') return this.tool(event);
        if (type === 'step_finish') return this.stepFinish(event);
        if (type === 'error') {
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
        };
    }

    private text(event: Record<string, unknown>): OpenCodeAdapterResult {
        const part = record(event.part);
        const text = string(part?.text);
        if (!text) return this.result([]);
        this.finalText += text;
        return this.result([{ type: 'output.text', data: { text } }], text);
    }

    private tool(event: Record<string, unknown>): OpenCodeAdapterResult {
        const part = record(event.part);
        const state = record(part?.state);
        const id = string(part?.callID) ?? string(part?.id) ?? 'unknown';
        const name = string(part?.tool) ?? 'tool';
        const status = string(state?.status) ?? 'unknown';
        const target = toolTarget(record(state?.input));
        const common = {
            id,
            name,
            ...(target ? { target } : {}),
        };
        const events: EventDraft[] = [];
        if (!this.startedTools.has(id)) {
            this.startedTools.add(id);
            events.push({ type: 'tool.started', data: common });
        }
        if (status === 'completed' || status === 'error' || status === 'failed') {
            events.push({
                type: 'tool.completed',
                data: {
                    ...common,
                    status: status === 'completed' ? 'completed' : 'failed',
                    ...duration(state),
                },
            });
            const changed = changedFile(name, target);
            if (changed) events.push({ type: 'file.changed', data: changed });
        }
        return this.result(events);
    }

    private stepFinish(event: Record<string, unknown>): OpenCodeAdapterResult {
        const part = record(event.part);
        const events: EventDraft[] = [];
        const tokens = record(part?.tokens);
        if (tokens) {
            const cache = record(tokens.cache);
            events.push({
                type: 'usage.updated',
                data: compact({
                    kind: 'delta',
                    total_tokens: number(tokens.total),
                    input_tokens: number(tokens.input),
                    output_tokens: number(tokens.output),
                    reasoning_tokens: number(tokens.reasoning),
                    cache_read_tokens: number(cache?.read),
                    cache_write_tokens: number(cache?.write),
                    cost_usd: number(part?.cost),
                }),
            });
        }
        const reason = string(part?.reason);
        if (reason && reason !== 'tool-calls') {
            this.turnCompleted = true;
            events.push({ type: 'turn.completed', data: { reason } });
        }
        return this.result(events);
    }

    private native(nativeType: string): OpenCodeAdapterResult {
        return this.result([
            { type: 'runner.event', data: { native_type: nativeType } },
        ]);
    }

    private result(events: EventDraft[], finalText?: string): OpenCodeAdapterResult {
        return {
            events,
            ...(finalText ? { finalText } : {}),
            turnCompleted: this.turnCompleted,
        };
    }
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

function compact(value: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(
        Object.entries(value).filter((entry) => entry[1] !== undefined)
    );
}

function duration(state: Record<string, unknown> | undefined) {
    const time = record(state?.time);
    const start = number(time?.start);
    const end = number(time?.end);
    return start !== undefined && end !== undefined && end >= start
        ? { duration_ms: end - start }
        : {};
}

function toolTarget(input: Record<string, unknown> | undefined): string | undefined {
    if (!input) return undefined;
    for (const key of ['filePath', 'path']) {
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
