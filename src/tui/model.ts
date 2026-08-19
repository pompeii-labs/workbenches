import type { WorkbenchEvent } from '../execution.js';

export type TranscriptItem =
    | { id: string; kind: 'user'; text: string }
    | { id: string; kind: 'assistant'; text: string }
    | {
          id: string;
          kind: 'tool';
          title: string;
          target?: string;
          detail?: string;
          status: 'running' | 'completed' | 'failed';
      }
    | { id: string; kind: 'notice'; text: string; tone: 'muted' | 'error' };

export interface TranscriptState {
    items: TranscriptItem[];
    busy: boolean;
    status: string;
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
        const previous = this.pendingText;
        this.pendingText = previous
            ? {
                  ...event,
                  data: { text: field(previous.data, 'text') + text },
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

    dispose(): void {
        if (this.timer !== undefined) this.cancel(this.timer);
        this.timer = undefined;
        this.pendingText = undefined;
    }
}

export function emptyTranscript(): TranscriptState {
    return { items: [], busy: false, status: 'Connecting' };
}

export function addUserMessage(
    state: TranscriptState,
    text: string,
    id: string = crypto.randomUUID()
): TranscriptState {
    return {
        ...state,
        items: [...state.items, { id, kind: 'user', text }],
        busy: true,
        status: 'Thinking',
    };
}

export function reduceTranscript(
    state: TranscriptState,
    event: WorkbenchEvent
): TranscriptState {
    if (event.type === 'run.ready') return { ...state, status: 'Ready' };
    if (event.type === 'turn.started') {
        return { ...state, busy: true, status: 'Thinking' };
    }
    if (event.type === 'output.text') {
        const text = field(event.data, 'text');
        if (!text) return state;
        const last = state.items.at(-1);
        if (last?.kind === 'assistant') {
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
                    id: `assistant-${event.sequence}`,
                    kind: 'assistant',
                    text,
                },
            ],
        };
    }
    if (event.type === 'tool.started') {
        return {
            ...state,
            status: 'Working',
            items: [
                ...state.items,
                {
                    id: field(event.data, 'id') || `tool-${event.sequence}`,
                    kind: 'tool',
                    title:
                        field(event.data, 'title') ||
                        humanize(field(event.data, 'name') || 'Tool'),
                    ...(field(event.data, 'target')
                        ? { target: field(event.data, 'target') }
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
                    ? {
                          ...item,
                          status:
                              field(event.data, 'status') === 'failed'
                                  ? 'failed'
                                  : 'completed',
                          ...(field(event.data, 'message')
                              ? { detail: field(event.data, 'message') }
                              : {}),
                      }
                    : item
            ),
        };
    }
    if (event.type === 'input.requested') {
        return { ...state, busy: true, status: 'Needs permission' };
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
    if (event.type === 'turn.completed') {
        return { ...state, busy: false, status: 'Ready' };
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
