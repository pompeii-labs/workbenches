export const WORKBENCH_EVENT_TYPES = [
    'run.started',
    'run.ready',
    'turn.started',
    'turn.completed',
    'output.text',
    'tool.started',
    'tool.completed',
    'file.changed',
    'input.requested',
    'input.accepted',
    'input.queued',
    'input.delivered',
    'input.rejected',
    'usage.updated',
    'run.completed',
    'run.failed',
    'run.cancelled',
    'runner.event',
] as const;

export type WorkbenchEventType = (typeof WORKBENCH_EVENT_TYPES)[number];

export interface WorkbenchEvent<T = unknown> {
    protocol: 0;
    run_id: string;
    sequence: number;
    timestamp: string;
    type: WorkbenchEventType;
    runner: string;
    data: T;
}

export interface WorkbenchEventDraft {
    type: WorkbenchEventType;
    data: Record<string, unknown>;
}

export interface RunEventsOptions {
    runId: string;
    runner: string;
    initialSequence?: number;
    onEvent?: (event: WorkbenchEvent) => Promise<void> | void;
    now?: () => Date;
}

export class RunEvents {
    readonly runId: string;

    private readonly runner: string;
    private readonly onEvent: NonNullable<RunEventsOptions['onEvent']>;
    private readonly now: NonNullable<RunEventsOptions['now']>;
    private sequence = 0;
    private delivery = Promise.resolve();

    constructor(options: RunEventsOptions) {
        if (!options.runId.trim()) throw new Error('runId must not be empty');
        if (!options.runner.trim()) throw new Error('runner must not be empty');
        if (
            options.initialSequence !== undefined &&
            (!Number.isSafeInteger(options.initialSequence) ||
                options.initialSequence < 0)
        ) {
            throw new Error('initialSequence must be a non-negative integer');
        }
        this.runId = options.runId;
        this.runner = options.runner;
        this.sequence = options.initialSequence ?? 0;
        this.onEvent = options.onEvent ?? (() => {});
        this.now = options.now ?? (() => new Date());
    }

    create<T>(type: WorkbenchEventType, data: T): WorkbenchEvent<T> {
        this.sequence += 1;
        return {
            protocol: 0,
            run_id: this.runId,
            sequence: this.sequence,
            timestamp: this.now().toISOString(),
            type,
            runner: this.runner,
            data,
        };
    }

    emitDraft(draft: WorkbenchEventDraft): Promise<WorkbenchEvent> {
        return this.emit(draft.type, draft.data);
    }

    async emit<T>(type: WorkbenchEventType, data: T): Promise<WorkbenchEvent<T>> {
        const event = this.create(type, data);
        const delivered = this.delivery.then(() => this.onEvent(event));
        this.delivery = delivered.then(
            () => undefined,
            () => undefined
        );
        await delivered;
        return event;
    }
}
