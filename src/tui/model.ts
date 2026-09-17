import type { WorkbenchEvent } from '../runs/index.js';

export interface ToolTranscriptItem {
    id: string;
    kind: 'tool';
    name: string;
    title: string;
    target?: string;
    description?: string;
    error?: string;
    durationMs?: number;
    status: 'running' | 'completed' | 'failed';
}

export interface OutcomeTranscriptItem {
    id: string;
    kind: 'outcome';
    outcomeId: string;
    applicationState: 'pending' | 'present' | 'applied';
    completeness: 'complete' | 'partial';
    turnIndex?: number;
    changesets: number;
    artifacts: number;
    links: number;
    warnings: number;
    summary?: string;
}

export type TranscriptItem =
    | { id: string; kind: 'user'; text: string; images?: string[] }
    | { id: string; kind: 'assistant'; text: string }
    | ToolTranscriptItem
    | OutcomeTranscriptItem
    | { id: string; kind: 'notice'; text: string; tone: 'muted' | 'error' };

export type TranscriptDisplayItem =
    | Exclude<TranscriptItem, ToolTranscriptItem>
    | { id: string; kind: 'activity'; tools: ToolTranscriptItem[] };

export interface QueuedTranscriptInput {
    id: string;
    text: string;
    images?: string[];
    controlId?: string;
}

export interface TranscriptState {
    items: TranscriptItem[];
    queued: QueuedTranscriptInput[];
    busy: boolean;
    status: string;
    interruptionPending: boolean;
    totalTokens?: number;
    costUsd?: number;
}

type Timer = ReturnType<typeof setTimeout>;

export class TranscriptEventBuffer {
    private pendingText: WorkbenchEvent | undefined;
    private timer: Timer | undefined;

    constructor(
        private readonly consume: (event: WorkbenchEvent) => void,
        private readonly delayMs = 40,
        private readonly schedule: (
            callback: () => void,
            delayMs: number
        ) => Timer = setTimeout,
        private readonly cancel: (timer: Timer) => void = clearTimeout
    ) {}

    push(event: WorkbenchEvent): void {
        if (event.type !== 'output.text') {
            this.flush();
            this.consume(event);
            return;
        }
        const text = field(event.data, 'text');
        if (!text) return;
        let previous = this.pendingText;
        if (previous && field(previous.data, 'id') !== field(event.data, 'id')) {
            this.flush();
            previous = undefined;
        }
        this.pendingText = previous
            ? {
                  ...event,
                  data: {
                      ...object(previous.data),
                      ...object(event.data),
                      text: field(previous.data, 'text') + text,
                  },
              }
            : event;
        if (this.timer !== undefined) return;
        this.timer = this.schedule(() => {
            this.timer = undefined;
            this.flush();
        }, this.delayMs);
    }

    flush(): void {
        if (this.timer !== undefined) {
            this.cancel(this.timer);
            this.timer = undefined;
        }
        const event = this.pendingText;
        if (!event) return;
        this.pendingText = undefined;
        this.consume(event);
    }

    discardText(): void {
        if (this.timer !== undefined) {
            this.cancel(this.timer);
            this.timer = undefined;
        }
        this.pendingText = undefined;
    }

    dispose(): void {
        this.discardText();
    }
}

export function emptyTranscript(): TranscriptState {
    return {
        items: [],
        queued: [],
        busy: false,
        status: 'Connecting',
        interruptionPending: false,
    };
}

export function groupTranscriptItems(items: TranscriptItem[]): TranscriptDisplayItem[] {
    const groups: TranscriptDisplayItem[] = [];
    for (const item of items) {
        if (item.kind !== 'tool') {
            groups.push(item);
            continue;
        }
        const previous = groups.at(-1);
        if (previous?.kind === 'activity') {
            previous.tools.push(item);
            continue;
        }
        groups.push({ id: `activity-${item.id}`, kind: 'activity', tools: [item] });
    }
    return groups;
}

export function addUserMessage(
    state: TranscriptState,
    text: string,
    id: string = crypto.randomUUID(),
    images: string[] = []
): TranscriptState {
    return {
        ...state,
        items: [
            ...state.items,
            { id, kind: 'user', text, ...(images.length > 0 ? { images } : {}) },
        ],
        busy: true,
        status: 'Thinking',
    };
}

export function queueUserMessage(
    state: TranscriptState,
    text: string,
    id: string = crypto.randomUUID(),
    images: string[] = []
): TranscriptState {
    return {
        ...state,
        queued: [
            ...state.queued,
            { id, text, ...(images.length > 0 ? { images } : {}) },
        ],
    };
}

export function interruptTranscript(
    state: TranscriptState,
    id: string = crypto.randomUUID()
): TranscriptState {
    if (!state.busy || state.interruptionPending) return state;
    return {
        ...state,
        busy: false,
        status: 'Interrupted',
        interruptionPending: true,
        items: [
            ...state.items,
            {
                id,
                kind: 'notice',
                text: 'Turn interrupted',
                tone: 'muted',
            },
        ],
    };
}

export function reduceTranscript(
    state: TranscriptState,
    event: WorkbenchEvent
): TranscriptState {
    if (event.type === 'input.queued' && field(event.data, 'kind') === 'steer') {
        const controlId = field(event.data, 'id');
        const index = state.queued.findIndex((input) => !input.controlId);
        if (!controlId || index === -1) return state;
        return {
            ...state,
            queued: state.queued.map((input, inputIndex) =>
                inputIndex === index ? { ...input, controlId } : input
            ),
        };
    }
    if (event.type === 'input.delivered' && field(event.data, 'kind') === 'steer') {
        const controlId = field(event.data, 'id');
        const index = state.queued.findIndex((input) => input.controlId === controlId);
        if (!controlId || index === -1) return state;
        const delivered = state.queued[index];
        if (!delivered) return state;
        return {
            ...state,
            busy: true,
            status: 'Thinking',
            queued: state.queued.filter((_, inputIndex) => inputIndex !== index),
            items: [
                ...state.items,
                {
                    id: delivered.id,
                    kind: 'user',
                    text: delivered.text,
                    ...(delivered.images ? { images: delivered.images } : {}),
                },
            ],
        };
    }
    if (event.type === 'input.rejected' && field(event.data, 'kind') === 'steer') {
        const controlId = field(event.data, 'id');
        const index = state.queued.findIndex((input) => input.controlId === controlId);
        if (!controlId || index === -1) return state;
        if (
            state.interruptionPending &&
            field(event.data, 'code') === 'steering_not_delivered'
        ) {
            return {
                ...state,
                queued: state.queued.filter((_, inputIndex) => inputIndex !== index),
            };
        }
        return {
            ...state,
            queued: state.queued.filter((_, inputIndex) => inputIndex !== index),
            items: [
                ...state.items,
                {
                    id: `rejected-${event.sequence}`,
                    kind: 'notice',
                    text: 'Queued steering input was not delivered',
                    tone: 'error',
                },
            ],
        };
    }
    if (event.type === 'run.ready') return { ...state, status: 'Ready' };
    if (event.type === 'authentication.requested') {
        const provider = field(event.data, 'provider') || 'provider';
        const url = field(event.data, 'url');
        const instructions = field(event.data, 'instructions');
        return {
            ...state,
            busy: true,
            status: 'Needs authentication',
            items: [
                ...state.items,
                {
                    id: `authentication-${event.sequence}`,
                    kind: 'notice',
                    text: [`Authenticate ${provider}`, url, instructions]
                        .filter(Boolean)
                        .join('\n'),
                    tone: 'muted',
                },
            ],
        };
    }
    if (event.type === 'authentication.completed') {
        return {
            ...state,
            busy: true,
            status: 'Starting',
            items: [
                ...state.items,
                {
                    id: `authentication-complete-${event.sequence}`,
                    kind: 'notice',
                    text: 'Authentication complete',
                    tone: 'muted',
                },
            ],
        };
    }
    if (event.type === 'turn.started') {
        return { ...state, busy: true, status: 'Thinking' };
    }
    if (event.type === 'output.text') {
        const text = field(event.data, 'text');
        if (!text) return state;
        const outputId = field(event.data, 'id');
        const itemId = outputId || `assistant-${event.sequence}`;
        const last = state.items.at(-1);
        if (last?.kind === 'assistant' && (!outputId || last.id === outputId)) {
            return {
                ...state,
                status: 'Responding',
                items: [
                    ...state.items.slice(0, -1),
                    { ...last, text: last.text + text },
                ],
            };
        }
        return {
            ...state,
            status: 'Responding',
            items: [
                ...state.items,
                {
                    id: itemId,
                    kind: 'assistant',
                    text,
                },
            ],
        };
    }
    if (event.type === 'tool.started') {
        const name = field(event.data, 'name') || 'tool';
        return {
            ...state,
            status: 'Working',
            items: [
                ...state.items,
                {
                    id: field(event.data, 'id') || `tool-${event.sequence}`,
                    kind: 'tool',
                    name,
                    title: field(event.data, 'title') || humanize(name),
                    ...(field(event.data, 'target')
                        ? { target: field(event.data, 'target') }
                        : {}),
                    ...(field(event.data, 'description')
                        ? { description: field(event.data, 'description') }
                        : {}),
                    status: 'running',
                },
            ],
        };
    }
    if (event.type === 'tool.completed') {
        const id = field(event.data, 'id');
        return {
            ...state,
            items: state.items.map((item) =>
                item.kind === 'tool' && item.id === id
                    ? completeTool(item, event)
                    : item
            ),
        };
    }
    if (event.type === 'input.requested') {
        return { ...state, busy: true, status: 'Needs permission' };
    }
    if (event.type === 'question.requested') {
        return { ...state, busy: true, status: 'Needs input' };
    }
    if (event.type === 'question.answered' || event.type === 'question.rejected') {
        return { ...state, busy: true, status: 'Working' };
    }
    if (event.type === 'usage.updated') {
        const tokens = numeric(event.data, 'total_tokens');
        const cost = numeric(event.data, 'cost_usd');
        return {
            ...state,
            ...(tokens === undefined ? {} : { totalTokens: tokens }),
            ...(cost === undefined ? {} : { costUsd: cost }),
        };
    }
    if (event.type === 'outcome.available') {
        const outcomeId = field(event.data, 'outcome_id');
        const applicationState = field(event.data, 'application_state');
        const completeness = field(event.data, 'completeness');
        if (
            !outcomeId ||
            !['pending', 'present', 'applied'].includes(applicationState) ||
            !['complete', 'partial'].includes(completeness)
        ) {
            return state;
        }
        const summary = field(event.data, 'summary');
        const turnIndex = numeric(event.data, 'turn_index');
        return {
            ...state,
            items: [
                ...state.items.filter(
                    (item) => item.kind !== 'outcome' || item.outcomeId !== outcomeId
                ),
                {
                    id: `outcome-${outcomeId}`,
                    kind: 'outcome',
                    outcomeId,
                    applicationState: applicationState as
                        | 'pending'
                        | 'present'
                        | 'applied',
                    completeness: completeness as 'complete' | 'partial',
                    ...(turnIndex !== undefined &&
                    Number.isSafeInteger(turnIndex) &&
                    turnIndex > 0
                        ? { turnIndex }
                        : {}),
                    changesets: numeric(event.data, 'changesets') ?? 0,
                    artifacts: numeric(event.data, 'artifacts') ?? 0,
                    links: numeric(event.data, 'links') ?? 0,
                    warnings: numeric(event.data, 'warnings') ?? 0,
                    ...(summary ? { summary } : {}),
                },
            ],
        };
    }
    if (event.type === 'outcome.failed') {
        return {
            ...state,
            items: [
                ...state.items,
                {
                    id: `outcome-failed-${event.run_id}-${event.sequence}`,
                    kind: 'notice',
                    tone: 'error',
                    text:
                        field(event.data, 'message') ||
                        'Could not save returned results.',
                },
            ],
        };
    }
    if (event.type === 'turn.completed') {
        const interrupted = field(event.data, 'reason') === 'cancelled';
        if (state.interruptionPending) {
            return { ...state, queued: [], interruptionPending: false };
        }
        return {
            ...state,
            busy: false,
            status: interrupted ? 'Interrupted' : 'Ready',
            items: interrupted
                ? [
                      ...state.items,
                      {
                          id: `interrupted-${event.sequence}`,
                          kind: 'notice',
                          text: 'Turn interrupted',
                          tone: 'muted',
                      },
                  ]
                : state.items,
        };
    }
    if (event.type === 'run.failed') {
        return {
            ...state,
            busy: false,
            status: 'Failed',
            items: [
                ...state.items,
                {
                    id: `error-${event.sequence}`,
                    kind: 'notice',
                    text: field(event.data, 'message') || 'Workbench run failed',
                    tone: 'error',
                },
            ],
        };
    }
    if (event.type === 'run.completed') {
        return { ...state, busy: false, status: 'Completed' };
    }
    if (event.type === 'run.cancelled') {
        return {
            ...state,
            busy: false,
            status: 'Cancelled',
            items: [
                ...state.items,
                {
                    id: `cancelled-${event.sequence}`,
                    kind: 'notice',
                    text: 'Turn cancelled',
                    tone: 'muted',
                },
            ],
        };
    }
    return state;
}

function completeTool(
    item: ToolTranscriptItem,
    event: WorkbenchEvent
): ToolTranscriptItem {
    const name = field(event.data, 'name');
    const title = field(event.data, 'title');
    const target = field(event.data, 'target');
    const description = field(event.data, 'description');
    const error = field(event.data, 'message');
    const durationMs = numeric(event.data, 'duration_ms');
    return {
        ...item,
        ...(name ? { name } : {}),
        ...(title ? { title } : {}),
        ...(target ? { target } : {}),
        ...(description ? { description } : {}),
        ...(error ? { error } : {}),
        ...(durationMs === undefined ? {} : { durationMs }),
        status: field(event.data, 'status') === 'failed' ? 'failed' : 'completed',
    };
}

export function reduceTranscriptDuringCancellation(
    state: TranscriptState,
    event: WorkbenchEvent
): TranscriptState {
    if (
        event.type === 'turn.completed' ||
        event.type === 'run.failed' ||
        event.type === 'run.cancelled' ||
        event.type === 'run.completed' ||
        event.type === 'outcome.available' ||
        event.type === 'outcome.failed' ||
        event.type === 'usage.updated'
    ) {
        return reduceTranscript(state, event);
    }
    return state;
}

function field(value: unknown, key: string): string {
    const record = object(value);
    return typeof record?.[key] === 'string' ? record[key] : '';
}

function numeric(value: unknown, key: string): number | undefined {
    const candidate = object(value)?.[key];
    return typeof candidate === 'number' && Number.isFinite(candidate)
        ? candidate
        : undefined;
}

function object(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
}

function humanize(value: string): string {
    const normalized = value.replaceAll('_', ' ');
    return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}
