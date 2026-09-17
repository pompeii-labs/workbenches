import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { WorkbenchEvent } from '../runs/events.js';
import { RunStore } from '../runs/store.js';
import { SessionStore } from '../sessions/index.js';
import {
    addUserMessage,
    emptyTranscript,
    reduceTranscript,
    type TranscriptItem,
    type TranscriptState,
} from './model.js';

interface StoredTranscript {
    version: 1;
    items: TranscriptItem[];
    cursor?: TranscriptCursor;
}

export interface TranscriptCursor {
    runId: string;
    sequence: number;
}

export interface RestoredTranscript {
    items: TranscriptItem[];
    cursor?: TranscriptCursor;
    ready?: boolean;
    state?: TranscriptState;
}

export class SessionTranscript {
    readonly #path: string;
    private pending: TranscriptItem[] | undefined;
    private pendingCursor: TranscriptCursor | undefined;
    private timer: ReturnType<typeof setTimeout> | undefined;
    private writing: Promise<void> = Promise.resolve();

    constructor(
        private readonly home: string,
        private readonly sessionId: string,
        private readonly delayMs = 150
    ) {
        this.#path = new SessionStore(home).transcriptPath(sessionId);
    }

    async load(): Promise<TranscriptItem[]> {
        return (await this.read())?.items ?? [];
    }

    async cursor(): Promise<TranscriptCursor | undefined> {
        return (await this.read())?.cursor;
    }

    async restore(): Promise<RestoredTranscript> {
        const runs = new RunStore(this.home);
        const history = (await runs.list())
            .filter(
                (run) =>
                    run.session_id === this.sessionId ||
                    (!run.session_id && run.id === this.sessionId)
            )
            .toSorted(
                (left, right) =>
                    left.dispatched_at.localeCompare(right.dispatched_at) ||
                    left.id.localeCompare(right.id)
            );
        if (history.length === 0) return (await this.read()) ?? { items: [] };
        const items: TranscriptItem[] = [];
        let cursor: TranscriptCursor | undefined;
        let ready = false;
        let state = emptyTranscript();
        for (const run of history) {
            let events = await runs.readEvents(run.id);
            state = rebuildRun(events);
            if (run === history.at(-1) && !RunStore.isTerminal(run.status)) {
                const requested =
                    state.status === 'Needs permission'
                        ? 'input.requested'
                        : state.status === 'Needs input'
                          ? 'question.requested'
                          : undefined;
                const boundary = requested
                    ? events.findLastIndex((event) => event.type === requested)
                    : -1;
                if (boundary >= 0) {
                    // Replay the outstanding request through the normal TUI handlers.
                    events = events.slice(0, boundary);
                    state = rebuildRun(events);
                }
            }
            const prefix =
                run === history.at(-1) && !RunStore.isTerminal(run.status)
                    ? ''
                    : `${run.id}:`;
            items.push(
                ...state.items.map((item) => ({
                    ...item,
                    id: `${prefix}${item.id}`,
                }))
            );
            cursor = { runId: run.id, sequence: events.at(-1)?.sequence ?? 0 };
            ready =
                !RunStore.isTerminal(run.status) &&
                events.some((event) => event.type === 'run.ready') &&
                !events.some((event) =>
                    ['run.completed', 'run.failed', 'run.cancelled'].includes(
                        event.type
                    )
                );
        }
        return {
            items,
            ...(cursor ? { cursor } : {}),
            ready,
            state: {
                ...state,
                items,
                busy: ready && state.busy,
                status: ready ? state.status : 'Connecting',
            },
        };
    }

    private async read(): Promise<StoredTranscript | undefined> {
        const source = await readFile(this.#path, 'utf8').catch(() => null);
        if (!source) return undefined;
        let value: unknown;
        try {
            value = JSON.parse(source);
        } catch {
            return undefined;
        }
        return isStoredTranscript(value) ? value : undefined;
    }

    schedule(items: TranscriptItem[], cursor?: TranscriptCursor): void {
        this.pending = structuredClone(items);
        this.pendingCursor = cursor ? { ...cursor } : undefined;
        if (this.timer !== undefined) return;
        this.timer = setTimeout(() => {
            this.timer = undefined;
            void this.flush().catch(() => {});
        }, this.delayMs);
    }

    async flush(): Promise<void> {
        if (this.timer !== undefined) {
            clearTimeout(this.timer);
            this.timer = undefined;
        }
        const items = this.pending;
        if (!items) return;
        const cursor = this.pendingCursor;
        this.pending = undefined;
        this.pendingCursor = undefined;
        const write = this.writing.then(() => this.write(items, cursor));
        this.writing = write.catch(() => {});
        await write;
    }

    private async write(
        items: TranscriptItem[],
        cursor?: TranscriptCursor
    ): Promise<void> {
        await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
        const temporary = `${this.#path}.${crypto.randomUUID()}.tmp`;
        await writeFile(
            temporary,
            `${JSON.stringify(
                {
                    version: 1,
                    items,
                    ...(cursor ? { cursor } : {}),
                } satisfies StoredTranscript,
                null,
                2
            )}\n`,
            { mode: 0o600 }
        );
        await rename(temporary, this.#path);
    }
}

function rebuildRun(events: WorkbenchEvent[]): TranscriptState {
    let state = emptyTranscript();
    const delivered = new Set<string>();
    for (const event of events) {
        const data =
            event.data && typeof event.data === 'object'
                ? (event.data as Record<string, unknown>)
                : {};
        if (
            event.type === 'input.delivered' &&
            (data.kind === 'send' || data.kind === 'steer')
        ) {
            const id =
                typeof data.id === 'string' ? data.id : `input-${event.sequence}`;
            if (typeof data.text !== 'string' || delivered.has(id)) continue;
            delivered.add(id);
            const images = Array.isArray(data.images)
                ? data.images.flatMap((image) => {
                      if (!image || typeof image !== 'object') return [];
                      const name = Reflect.get(image, 'name');
                      return [typeof name === 'string' ? name : 'Image'];
                  })
                : [];
            state = addUserMessage(state, data.text, id, images);
            continue;
        }
        if (event.type === 'run.failed') {
            if (!state.items.some((item) => item.kind !== 'notice')) continue;
            state = reduceTranscript(state, {
                ...event,
                data: {
                    ...data,
                    message: `Previous run failed: ${typeof data.message === 'string' ? data.message : 'Workbench run failed'}`,
                },
            });
            continue;
        }
        state = reduceTranscript(state, event);
    }
    return state;
}

function isStoredTranscript(value: unknown): value is StoredTranscript {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const version = Reflect.get(value, 'version');
    const items = Reflect.get(value, 'items');
    const cursor = Reflect.get(value, 'cursor');
    return (
        version === 1 &&
        Array.isArray(items) &&
        items.every(isTranscriptItem) &&
        (cursor === undefined || isTranscriptCursor(cursor))
    );
}

function isTranscriptCursor(value: unknown): value is TranscriptCursor {
    return (
        value !== null &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        typeof Reflect.get(value, 'runId') === 'string' &&
        typeof Reflect.get(value, 'sequence') === 'number'
    );
}

function isTranscriptItem(value: unknown): value is TranscriptItem {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const id = Reflect.get(value, 'id');
    const kind = Reflect.get(value, 'kind');
    if (typeof id !== 'string' || typeof kind !== 'string') return false;
    if (kind === 'user' || kind === 'assistant') {
        return typeof Reflect.get(value, 'text') === 'string';
    }
    if (kind === 'notice') {
        return (
            typeof Reflect.get(value, 'text') === 'string' &&
            ['muted', 'error'].includes(String(Reflect.get(value, 'tone')))
        );
    }
    if (kind === 'outcome') {
        return (
            typeof Reflect.get(value, 'outcomeId') === 'string' &&
            ['pending', 'present', 'applied'].includes(
                String(Reflect.get(value, 'applicationState'))
            ) &&
            ['complete', 'partial'].includes(
                String(Reflect.get(value, 'completeness'))
            ) &&
            (Reflect.get(value, 'turnIndex') === undefined ||
                (Number.isSafeInteger(Reflect.get(value, 'turnIndex')) &&
                    Number(Reflect.get(value, 'turnIndex')) > 0)) &&
            ['changesets', 'artifacts', 'links', 'warnings'].every(
                (field) =>
                    typeof Reflect.get(value, field) === 'number' &&
                    Number.isSafeInteger(Reflect.get(value, field)) &&
                    Number(Reflect.get(value, field)) >= 0
            ) &&
            (Reflect.get(value, 'summary') === undefined ||
                typeof Reflect.get(value, 'summary') === 'string')
        );
    }
    return (
        kind === 'tool' &&
        typeof Reflect.get(value, 'name') === 'string' &&
        typeof Reflect.get(value, 'title') === 'string' &&
        ['running', 'completed', 'failed'].includes(
            String(Reflect.get(value, 'status'))
        )
    );
}
