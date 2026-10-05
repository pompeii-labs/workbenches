import type { WorkbenchEventDraft } from '../../runs/events.js';
import { describeTool, planFromTodos } from '../tool.js';
import { record, string } from './json.js';

export interface OpenCodeAdapterResult {
    events: WorkbenchEventDraft[];
    finalText?: string;
    turnCompleted: boolean;
}

export interface OpenCodeAdapterProgress {
    startedTools: string[];
    completedTools: string[];
    finishedSteps: string[];
}

export class OpenCodeEventAdapter {
    private readonly startedTools = new Set<string>();
    private readonly completedTools = new Set<string>();
    private readonly finishedSteps = new Set<string>();
    private turnCompleted = false;
    private finalText = '';
    private sessionId: string | undefined;
    private completionReason: string | undefined;
    private failureMessage: string | undefined;

    /** The tool calls and usage steps reported so far, by native id. */
    progress(): OpenCodeAdapterProgress {
        return {
            startedTools: [...this.startedTools],
            completedTools: [...this.completedTools],
            finishedSteps: [...this.finishedSteps],
        };
    }

    /** Makes the reported ids exactly those of an earlier `progress()`. */
    restore(state: OpenCodeAdapterProgress): void {
        this.startedTools.clear();
        this.completedTools.clear();
        this.finishedSteps.clear();
        for (const id of state.startedTools) this.startedTools.add(id);
        for (const id of state.completedTools) this.completedTools.add(id);
        for (const id of state.finishedSteps) this.finishedSteps.add(id);
    }

    /** Forgets what the previous turn's events said, so the next summary is its own. */
    startTurn(): void {
        this.turnCompleted = false;
        this.finalText = '';
        this.completionReason = undefined;
        this.failureMessage = undefined;
    }

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
        const id = string(part?.messageID) ?? string(part?.id);
        return this.result(
            [{ type: 'output.text', data: { ...(id ? { id } : {}), text } }],
            text
        );
    }

    private tool(event: Record<string, unknown>): OpenCodeAdapterResult {
        const part = record(event.part);
        const state = record(part?.state);
        const id = string(part?.callID) ?? string(part?.id) ?? 'unknown';
        const name = string(part?.tool) ?? 'tool';
        if (name.toLowerCase() === 'question') return this.result([]);
        const status = string(state?.status) ?? 'unknown';
        const description = describeTool(
            name,
            record(state?.input),
            record(state?.metadata)
        );
        const common = {
            id,
            name,
            ...description,
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
            const changed = changedFile(name, description.target);
            if (changed) events.push({ type: 'file.changed', data: changed });
            const plan = status === 'completed' ? planEvent(name, state) : undefined;
            if (plan) events.push(plan);
        }
        return this.result(events);
    }

    private stepFinish(event: Record<string, unknown>): OpenCodeAdapterResult {
        const part = record(event.part);
        const id = string(part?.id);
        if (id && this.finishedSteps.has(id)) return this.result([]);
        const events: WorkbenchEventDraft[] = [];
        const tokens = record(part?.tokens);
        if (tokens || number(part?.cost) !== undefined) {
            if (id) this.finishedSteps.add(id);
            const cache = record(tokens?.cache);
            events.push({
                type: 'usage.updated',
                data: compact({
                    kind: 'delta',
                    total_tokens: number(tokens?.total),
                    input_tokens: number(tokens?.input),
                    output_tokens: number(tokens?.output),
                    reasoning_tokens: number(tokens?.reasoning),
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

/** The agent's todo list after a todo tool call, as a portable plan. */
function planEvent(
    name: string,
    state: Record<string, unknown> | undefined
): WorkbenchEventDraft | undefined {
    if (!['todowrite', 'todo_write'].includes(name.trim().toLowerCase())) {
        return undefined;
    }
    const items = planFromTodos(record(state?.input));
    if (!items) return undefined;
    return {
        type: 'plan.updated',
        data: {
            items,
            completed: items.filter((item) => item.status === 'completed').length,
            total: items.filter((item) => item.status !== 'cancelled').length,
        },
    };
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
