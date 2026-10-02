import { record, string } from './json.js';

/**
 * A session's transcript, the body of `GET /session/:id/message`: a list of
 * messages, each with an `info` record and its `parts`. It is what a turn is
 * caught up from after the event stream was lost.
 */

export interface TranscriptMessage {
    info: Record<string, unknown>;
    parts: unknown[];
    /** The native message id. */
    id: string;
    /** The input message this one answers. */
    parentId: string;
}

export type TurnEnd =
    | { kind: 'cancelled' }
    | { kind: 'failed' }
    | { kind: 'completed'; finish: string | undefined };

/** A turn as the transcript holds it. */
export interface TranscriptTurn {
    answers: TranscriptMessage[];
    /** How the turn ended, or `undefined` while it runs. */
    end: TurnEnd | undefined;
}

/** The id that groups the text of one assistant message, stable across restarts. */
export function outputIdFor(messageId: string): string {
    return `output_${messageId}`;
}

/** How a turn ended, judged from its latest assistant message, or `undefined` while it runs. */
function turnEnd(last: Record<string, unknown>): TurnEnd | undefined {
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

export class OpenCodeTranscript {
    private readonly messages: Record<string, unknown>[];

    /** Takes the response body as received; anything that is not a list is empty. */
    constructor(body: unknown) {
        this.messages = (Array.isArray(body) ? body : [])
            .map(record)
            .filter((message) => message !== undefined);
    }

    latestUserMessageId(): string | undefined {
        for (const message of this.messages.toReversed()) {
            const info = record(message.info);
            if (info?.role === 'user') return string(info.id);
        }
        return undefined;
    }

    /**
     * The turn begun by `inputId`: the assistant messages that answer it or any of
     * `inputIds`, the steering inputs sent to it, in order. A user message that is
     * not one of the turn's inputs starts another turn, so the list stops there.
     * The turn has ended only if the latest answer to its last input says so; a
     * last input with no answer yet means it is still running. An input message
     * the transcript does not hold is an error, since no event could settle a
     * turn that is not there.
     */
    turnOf(inputId: string, inputIds: Iterable<string> = []): TranscriptTurn {
        const inputs = new Set([inputId, ...inputIds]);
        const start = this.messages.findIndex(
            (message) => string(record(message.info)?.id) === inputId
        );
        if (start === -1) throw new Error(`no turn to resume for message ${inputId}`);
        const answers: TranscriptMessage[] = [];
        let lastInput = inputId;
        for (const message of this.messages.slice(start + 1)) {
            const info = record(message.info);
            const id = string(info?.id);
            if (info?.role === 'user') {
                if (!id || !inputs.has(id)) break;
                lastInput = id;
                continue;
            }
            const parentId = string(info?.parentID);
            if (
                info?.role !== 'assistant' ||
                !id ||
                !parentId ||
                !inputs.has(parentId)
            ) {
                continue;
            }
            answers.push({
                info,
                id,
                parentId,
                parts: Array.isArray(message.parts) ? message.parts : [],
            });
        }
        const latest = answers.findLast((answer) => answer.parentId === lastInput);
        return { answers, end: latest && turnEnd(latest.info) };
    }

    /**
     * Drops text deltas that the transcript already contains. Events held during a
     * catch-up can include ones generated before the transcript was read. For each
     * part, a leading run of held deltas that the part's text ends with is already
     * in the transcript.
     */
    withoutCoveredDeltas(held: unknown[]): unknown[] {
        const transcriptText = new Map<string, string>();
        for (const message of this.messages) {
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
}
