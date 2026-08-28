import type { WorkbenchEventDraft } from '../../runs/index.js';

export interface OpenCodeAdapterResult {
    events: WorkbenchEventDraft[];
    finalText?: string;
    turnCompleted: boolean;
}

export class OpenCodeEventAdapter {
    private readonly startedTools = new Set<string>();
    private readonly completedTools = new Set<string>();
    private turnCompleted = false;
    private finalText = '';
    private sessionId: string | undefined;
    private completionReason: string | undefined;
    private failureMessage: string | undefined;

    consume(value: unknown): OpenCodeAdapterResult {
        const event = record(value);
        if (!event) return this.native('malformed');
        const sessionId = string(event.sessionID);
        if (!this.sessionId && sessionId) this.sessionId = sessionId;
        const type = string(event.type);
        if (!type) return this.native('unknown');

        if (type === 'step_start') return this.result([]);
        if (type === 'text') return this.text(event);
        if (type === 'tool_use') return this.tool(event);
        if (type === 'step_finish') return this.stepFinish(event);
        if (type === 'error') {
            this.failureMessage ??= safeRunnerError(event);
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
        const events: WorkbenchEventDraft[] = [];
        if (!this.startedTools.has(id)) {
            this.startedTools.add(id);
            events.push({ type: 'tool.started', data: common });
        }
        if (
            (status === 'completed' || status === 'error' || status === 'failed') &&
            !this.completedTools.has(id)
        ) {
            this.completedTools.add(id);
            const failure = status === 'completed' ? undefined : safeToolFailure(state);
            events.push({
                type: 'tool.completed',
                data: {
                    ...common,
                    status: status === 'completed' ? 'completed' : 'failed',
                    ...(failure ?? {}),
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
        const events: WorkbenchEventDraft[] = [];
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
            this.completionReason = reason;
            events.push({ type: 'turn.completed', data: { reason } });
        }
        return this.result(events);
    }

    private native(nativeType: string): OpenCodeAdapterResult {
        return this.result([
            { type: 'runner.event', data: { native_type: nativeType } },
        ]);
    }

    private result(
        events: WorkbenchEventDraft[],
        finalText?: string
    ): OpenCodeAdapterResult {
        return {
            events,
            ...(finalText ? { finalText } : {}),
            turnCompleted: this.turnCompleted,
        };
    }
}

function safeToolFailure(state: Record<string, unknown> | undefined) {
    const error = string(state?.error)?.toLowerCase() ?? '';
    if (error.includes('permission') || error.includes('rejected')) {
        return {
            error_code: 'permission_denied',
            message: 'Permission denied',
        };
    }
    return { error_code: 'runner_error', message: 'Tool failed in runner' };
}

function safeRunnerError(event: Record<string, unknown>): string | undefined {
    const error = record(event.error);
    const data = record(error?.data);
    const message = string(data?.message) ?? string(error?.message);
    if (!message) return undefined;
    const status = number(data?.statusCode);
    const normalized = message.replace(/\s+/g, ' ').trim().slice(0, 500);
    return status === undefined ? normalized : `HTTP ${status}: ${normalized}`;
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
