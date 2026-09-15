import type { RunControlReceipt, RunHandle, WorkbenchEvent } from '../runs/index.js';

export class TurnCancellation {
    private pendingRequest: Promise<RunControlReceipt> | undefined;

    get pending(): boolean {
        return this.pendingRequest !== undefined;
    }

    request(session: Pick<RunHandle, 'cancelTurn'>): Promise<RunControlReceipt> {
        if (this.pendingRequest) return this.pendingRequest;
        const pending = session.cancelTurn().finally(() => {
            if (this.pendingRequest === pending) this.pendingRequest = undefined;
        });
        this.pendingRequest = pending;
        return pending;
    }
}

export async function consumeEvents(
    session: RunHandle,
    signal: AbortSignal,
    afterSequence: number | undefined,
    consume: (event: WorkbenchEvent) => void
): Promise<void> {
    for await (const event of session.observe({
        signal,
        ...(afterSequence === undefined ? {} : { afterSequence }),
    })) {
        consume(event);
    }
}

export function eventData(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
}
