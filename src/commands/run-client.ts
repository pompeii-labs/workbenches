import type { RunHandle, WorkbenchEvent } from '../runs/index.js';

export interface FollowRunOptions {
    afterSequence?: number;
    include?: (event: WorkbenchEvent) => boolean;
    until?: (event: WorkbenchEvent) => boolean;
}

export interface FollowRunResult {
    interrupted: boolean;
    reachedBoundary: boolean;
    terminalStatus?: 'completed' | 'failed' | 'cancelled';
}

export class CliRunClient {
    async follow(
        handle: RunHandle,
        render: (event: WorkbenchEvent) => void,
        options: FollowRunOptions = {}
    ): Promise<FollowRunResult> {
        const controller = new AbortController();
        let interrupted = false;
        let reachedBoundary = false;
        let terminalStatus: FollowRunResult['terminalStatus'];
        const interrupt = () => {
            interrupted = true;
            controller.abort();
        };
        process.once('SIGINT', interrupt);
        try {
            for await (const event of handle.observe({
                ...(options.afterSequence === undefined
                    ? {}
                    : { afterSequence: options.afterSequence }),
                signal: controller.signal,
            })) {
                if (!options.include || options.include(event)) render(event);
                terminalStatus = terminalStatusFrom(event) ?? terminalStatus;
                if (options.until?.(event)) {
                    reachedBoundary = true;
                    break;
                }
            }
        } finally {
            process.removeListener('SIGINT', interrupt);
        }
        return {
            interrupted,
            reachedBoundary,
            ...(terminalStatus ? { terminalStatus } : {}),
        };
    }

    followInput(
        handle: RunHandle,
        inputId: string,
        render: (event: WorkbenchEvent) => void,
        afterSequence = 0,
        waitForRunEnd = false
    ): Promise<FollowRunResult> {
        const view = new InputEventView(inputId, afterSequence === 0);
        let completed = false;
        return this.follow(handle, render, {
            afterSequence,
            include: (event) => {
                if (completedInput(event, inputId)) completed = true;
                return (
                    (waitForRunEnd &&
                        (event.type === 'outcome.available' ||
                            event.type === 'delivery.started' ||
                            event.type === 'delivery.completed' ||
                            event.type === 'delivery.failed' ||
                            event.type === 'run.completed')) ||
                    view.includes(event)
                );
            },
            ...(waitForRunEnd
                ? {}
                : { until: (event: WorkbenchEvent) => completedInput(event, inputId) }),
        }).then((result) => ({
            ...result,
            reachedBoundary: result.reachedBoundary || completed,
        }));
    }
}

class InputEventView {
    private active = false;

    constructor(
        private readonly inputId: string,
        private readonly includePrelude: boolean
    ) {}

    includes(event: WorkbenchEvent): boolean {
        if (
            this.includePrelude &&
            (event.type === 'run.started' ||
                event.type === 'run.ready' ||
                event.type === 'repository.preparing' ||
                event.type === 'repository.ready')
        ) {
            return true;
        }
        if (inputLifecycleEvents.has(event.type)) {
            return eventId(event) === this.inputId;
        }
        if (event.type === 'turn.started') {
            this.active = eventId(event, 'input_id') === this.inputId;
            return this.active;
        }
        if (event.type === 'run.failed' || event.type === 'run.cancelled') return true;
        if (!this.active) return false;
        if (event.type === 'turn.completed') this.active = false;
        return true;
    }
}

const inputLifecycleEvents = new Set([
    'input.accepted',
    'input.queued',
    'input.delivered',
    'input.rejected',
]);

function eventId(event: WorkbenchEvent, field = 'id'): string | undefined {
    const data =
        event.data !== null && typeof event.data === 'object'
            ? (event.data as Record<string, unknown>)
            : undefined;
    const value = data?.[field];
    return typeof value === 'string' ? value : undefined;
}

function completedInput(event: WorkbenchEvent, inputId: string): boolean {
    return event.type === 'turn.completed' && eventId(event, 'input_id') === inputId;
}

function terminalStatusFrom(event: WorkbenchEvent): FollowRunResult['terminalStatus'] {
    if (event.type === 'run.completed') return 'completed';
    if (event.type === 'run.failed') return 'failed';
    if (event.type === 'run.cancelled') return 'cancelled';
    return undefined;
}
