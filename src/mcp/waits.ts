import {
    type CloudRunStatus,
    type CloudRuns,
    isCloudTerminal,
} from '../cloud/index.js';
import type { WorkbenchEvent } from '../runs/events.js';
import type { PendingRunRequest } from '../runs/supervision.js';

export interface McpCloudWaitRequest {
    after?: number;
    timeoutSeconds?: number;
}

export class McpCloudWait {
    async wait(
        cloud: CloudRuns,
        sessionId: string,
        runId: string,
        request: McpCloudWaitRequest
    ): Promise<Record<string, unknown>> {
        const after = request.after ?? 0;
        const history = await allEvents(cloud, runId);
        let run = await cloud.run(runId);
        const existing = history.filter((event) => event.sequence > after);
        const boundary = existing.find(boundaryEvent);
        const observedHistory = boundary
            ? history.filter((event) => event.sequence <= boundary.sequence)
            : history;
        const pending = pendingFromEvents(observedHistory);
        let received: WorkbenchEvent[] = [];
        let next = Math.max(after, boundary?.sequence ?? history.at(-1)?.sequence ?? 0);
        let reason: 'boundary' | 'timeout' = 'boundary';
        if (
            !pending.length &&
            run.status !== 'needs_input' &&
            !isCloudTerminal(run.status) &&
            !boundary
        ) {
            const waited = await collectEvents(
                cloud,
                runId,
                next,
                Math.min(request.timeoutSeconds ?? 60, 60) * 1000
            );
            received = waited.events;
            next = waited.next;
            reason = waited.reason;
            run = await cloud.run(runId);
        }
        const observedBoundary = boundary ?? received.find(boundaryEvent);
        if (observedBoundary) next = observedBoundary.sequence;
        const all = [...history, ...received].filter((event) => event.sequence <= next);
        const terminal = observedBoundary
            ? terminalBoundary(observedBoundary)
            : isCloudTerminal(run.status);
        const unresolved = terminal ? [] : pendingFromEvents(all);
        const usage = usageFromEvents(all.filter((event) => event.sequence > after));
        const outcome = all
            .toReversed()
            .find((event) => event.type === 'outcome.available');
        const outcomeId =
            outcome &&
            isRecord(outcome.data) &&
            typeof outcome.data.outcome_id === 'string'
                ? outcome.data.outcome_id
                : undefined;
        const state = unresolved.length
            ? 'needs_input'
            : observedBoundary?.type === 'turn.completed'
              ? 'turn_completed'
              : observedBoundary && terminalBoundary(observedBoundary)
                ? terminalState(observedBoundary)
                : cloudState(run.status, reason);
        return {
            session_id: sessionId,
            run_id: runId,
            next,
            state,
            final: run.final_response ?? '',
            usage,
            usage_total: run.usage ?? {},
            pending_requests: unresolved,
            ...(outcomeId ? { outcome_id: outcomeId } : {}),
            ...((state === 'failed' || state === 'cancelled') && run.terminal_reason
                ? { error: run.terminal_reason }
                : {}),
        };
    }
}

async function allEvents(cloud: CloudRuns, runId: string): Promise<WorkbenchEvent[]> {
    const events: WorkbenchEvent[] = [];
    let after = 0;
    while (true) {
        const page = await cloud.events(runId, after, 500);
        events.push(...page.events);
        if (page.events.length < 500 || page.next === after) return events;
        after = page.next;
    }
}

async function collectEvents(
    cloud: CloudRuns,
    runId: string,
    after: number,
    timeout: number
): Promise<{ events: WorkbenchEvent[]; next: number; reason: 'boundary' | 'timeout' }> {
    const events: WorkbenchEvent[] = [];
    let next = after;
    let socket: WebSocket | undefined;
    return new Promise((resolve, reject) => {
        let settled = false;
        let quiet: ReturnType<typeof setTimeout> | undefined;
        const finish = (reason: 'boundary' | 'timeout') => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            clearTimeout(quiet);
            socket?.close();
            resolve({ events, next, reason });
        };
        const timer = setTimeout(() => finish('timeout'), timeout);
        const fail = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            clearTimeout(quiet);
            socket?.close();
            reject(new Error('Cloud events WebSocket failed'));
        };
        void cloud
            .subscribe(runId, after, {
                event: (event) => {
                    if (event.sequence <= next) return;
                    events.push(event);
                    next = event.sequence;
                    if (boundaryEvent(event)) finish('boundary');
                    if (
                        event.type === 'input.requested' ||
                        event.type === 'question.requested' ||
                        event.type === 'authentication.requested'
                    ) {
                        clearTimeout(quiet);
                        quiet = setTimeout(() => finish('boundary'), 100);
                    }
                },
                close: () => finish('timeout'),
                error: fail,
            })
            .then((opened) => {
                socket = opened;
                if (settled) opened.close();
            })
            .catch(fail);
    });
}

function pendingFromEvents(events: WorkbenchEvent[]): Record<string, unknown>[] {
    const resolved = new Set(
        events
            .filter((event) =>
                [
                    'input.accepted',
                    'input.rejected',
                    'question.answered',
                    'question.rejected',
                ].includes(event.type)
            )
            .flatMap((event) =>
                isRecord(event.data) && typeof event.data.id === 'string'
                    ? [event.data.id]
                    : []
            )
    );
    const completedAuthentication = new Set(
        events.flatMap((event) =>
            event.type === 'authentication.completed' &&
            isRecord(event.data) &&
            typeof event.data.provider === 'string'
                ? [event.data.provider]
                : []
        )
    );
    return events.flatMap((event) => {
        if (
            event.type === 'authentication.requested' &&
            isRecord(event.data) &&
            typeof event.data.provider === 'string' &&
            !completedAuthentication.has(event.data.provider)
        )
            return [pendingRequest(event)];
        if (
            (event.type !== 'input.requested' && event.type !== 'question.requested') ||
            !isRecord(event.data) ||
            typeof event.data.id !== 'string' ||
            resolved.has(event.data.id)
        )
            return [];
        return [pendingRequest(event)];
    });
}

function pendingRequest(event: WorkbenchEvent): Record<string, unknown> {
    if (!isRecord(event.data)) return {};
    const authentication = event.type === 'authentication.requested';
    const id = authentication
        ? typeof event.data.provider === 'string'
            ? `authentication:${event.data.provider}`
            : ''
        : typeof event.data.id === 'string'
          ? event.data.id
          : '';
    if (!id) return {};
    const request: PendingRunRequest = {
        id,
        kind: authentication
            ? 'authentication'
            : event.type === 'question.requested'
              ? 'question'
              : 'permission',
        sequence: event.sequence,
        details: event.data,
    };
    const details = request.details;
    if (request.kind === 'question') {
        const questions = Array.isArray(details.questions) ? details.questions : [];
        return {
            id: request.id,
            kind: request.kind,
            text: questions
                .flatMap((question) =>
                    isRecord(question) && typeof question.question === 'string'
                        ? [question.question]
                        : []
                )
                .join('\n'),
            options: questions.map((question) =>
                isRecord(question) && Array.isArray(question.options)
                    ? question.options
                    : []
            ),
        };
    }
    return {
        id: request.id,
        kind: request.kind,
        text:
            typeof details.message === 'string'
                ? details.message
                : typeof details.instructions === 'string'
                  ? details.instructions
                  : '',
        options: Array.isArray(details.options) ? details.options : [],
    };
}

function usageFromEvents(events: WorkbenchEvent[]): Record<string, number> {
    const usage = { input_tokens: 0, output_tokens: 0, cost_usd: 0 };
    for (const event of events) {
        if (event.type !== 'usage.updated' || !isRecord(event.data)) continue;
        for (const name of Object.keys(usage) as (keyof typeof usage)[]) {
            const value = event.data[name];
            if (typeof value === 'number' && Number.isFinite(value))
                usage[name] += value;
        }
    }
    return usage;
}

function boundaryEvent(event: WorkbenchEvent): boolean {
    return (
        event.type === 'turn.completed' ||
        event.type === 'run.completed' ||
        event.type === 'run.failed' ||
        event.type === 'run.cancelled'
    );
}

function terminalBoundary(event: WorkbenchEvent): boolean {
    return (
        event.type === 'run.completed' ||
        event.type === 'run.failed' ||
        event.type === 'run.cancelled'
    );
}

function terminalState(event: WorkbenchEvent): 'completed' | 'failed' | 'cancelled' {
    if (event.type === 'run.completed') return 'completed';
    if (event.type === 'run.failed') return 'failed';
    return 'cancelled';
}

function cloudState(status: CloudRunStatus, reason: 'boundary' | 'timeout'): string {
    if (reason === 'timeout' && !isCloudTerminal(status)) return 'timeout';
    if (status === 'needs_input' || isCloudTerminal(status)) return status;
    return 'running';
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
