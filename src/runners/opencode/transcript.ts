import { record, string } from './values.js';

/**
 * Reading a session's transcript, `GET /session/:id/message`: a list of
 * messages, each with an `info` record and its `parts`. These are the pure
 * parts of catching a turn up after the event stream was lost.
 */

export interface TranscriptMessage {
    info: Record<string, unknown>;
    parts: unknown[];
    /** The native message id. */
    id: string;
}

/** The id that groups the text of one assistant message, stable across restarts. */
export function outputIdFor(messageId: string): string {
    return `output_${messageId}`;
}

export function latestUserMessageId(
    messages: Record<string, unknown>[]
): string | undefined {
    for (const message of messages.toReversed()) {
        const info = record(message.info);
        if (info?.role === 'user') return string(info.id);
    }
    return undefined;
}

/**
 * The assistant messages that answer the turn begun by `inputId`, in order. The
 * next user message starts another turn, so the list stops there.
 */
export function assistantMessagesOf(
    messages: Record<string, unknown>[],
    inputId: string
): TranscriptMessage[] {
    const start = messages.findIndex(
        (message) => string(record(message.info)?.id) === inputId
    );
    const answers: TranscriptMessage[] = [];
    for (const message of messages.slice(start + 1)) {
        const info = record(message.info);
        if (info?.role === 'user') break;
        const id = string(info?.id);
        if (info?.role !== 'assistant' || !id || string(info.parentID) !== inputId) {
            continue;
        }
        answers.push({
            info,
            id,
            parts: Array.isArray(message.parts) ? message.parts : [],
        });
    }
    return answers;
}

export type TurnEnd =
    | { kind: 'cancelled' }
    | { kind: 'failed' }
    | { kind: 'completed'; finish: string | undefined };

/** How a turn ended, judged from its last assistant message, or `undefined` while it runs. */
export function turnEnd(last: Record<string, unknown>): TurnEnd | undefined {
    const error = record(last.error);
    if (error) {
        return string(error.name) === 'MessageAbortedError'
            ? { kind: 'cancelled' }
            : { kind: 'failed' };
    }
    if (
        typeof record(last.time)?.completed === 'number' &&
        string(last.finish) !== 'tool-calls'
    ) {
        return { kind: 'completed', finish: string(last.finish) };
    }
    return undefined;
}

/**
 * Drops text deltas that the transcript already contains. Events held during a
 * catch-up can include ones generated before the transcript was read. For each
 * part, a leading run of held deltas that the part's text ends with is already
 * in the transcript.
 */
export function withoutCoveredDeltas(
    held: unknown[],
    messages: Record<string, unknown>[]
): unknown[] {
    const transcriptText = new Map<string, string>();
    for (const message of messages) {
        for (const part of Array.isArray(message.parts) ? message.parts : []) {
            const native = record(part);
            const id = string(native?.id);
            if (id && native?.type === 'text' && typeof native.text === 'string') {
                transcriptText.set(id, native.text);
            }
        }
    }
    const deltas = new Map<string, Array<{ index: number; delta: string }>>();
    for (const [index, value] of held.entries()) {
        const event = record(value);
        const properties = record(event?.properties);
        const partId = string(properties?.partID);
        const delta = string(properties?.delta);
        if (
            event?.type === 'message.part.delta' &&
            properties?.field === 'text' &&
            partId &&
            delta
        ) {
            deltas.set(partId, [...(deltas.get(partId) ?? []), { index, delta }]);
        }
    }
    const covered = new Set<number>();
    for (const [partId, list] of deltas) {
        const text = transcriptText.get(partId);
        if (text === undefined) continue;
        for (let count = list.length; count > 0; count--) {
            const run = list.slice(0, count);
            if (text.endsWith(run.map((entry) => entry.delta).join(''))) {
                for (const entry of run) covered.add(entry.index);
                break;
            }
        }
    }
    return held.filter((_, index) => !covered.has(index));
}
