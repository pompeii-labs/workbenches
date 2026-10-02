import type { RunnerSessionHost } from '../session.js';
import { type OpenCodeAdapterProgress, OpenCodeEventAdapter } from './events.js';
import { string } from './json.js';
import type { ActiveTurn } from './turn.js';

/**
 * What a session has emitted for one turn, keyed by native ids: characters per
 * assistant text part, and the tool calls and usage steps reported. It names the
 * session and the turn it belongs to, and `restoreProgress` refuses a value for
 * another session or turn.
 *
 * A host persists it as plain JSON while a turn runs and hands the saved value
 * to `restoreProgress` on the session it starts after a restart, so that
 * `resumeTurn` emits only what the host has not seen. The host must keep the
 * latest value it received, whole, and must not edit, merge, or trim it: a
 * missing id makes the session emit that tool call or usage step again, and a
 * larger count skips text the host never saw. It holds native ids and counts,
 * never content.
 *
 * Delivery is exactly once only if the host stores the progress atomically with
 * the events it stored. A value older than the events stored makes the session
 * emit some of them again; one newer skips events the host never stored. Text is
 * counted after the host's `emit` resolves, so an event whose `emit` failed is
 * sent again.
 *
 * Text counts are UTF-16 code units, the unit of a JavaScript string length. A
 * transcript that rewrites text already emitted, rather than extending it, is
 * not sent again: only text past the count is emitted.
 */
export interface OpenCodeProgress extends OpenCodeAdapterProgress {
    /** The native session the progress belongs to. */
    sessionId: string;
    /** The first input message of the turn, or none before a turn has started. */
    inputMessageId?: string;
    /** Characters emitted so far, by native text part id. */
    text: Record<string, number>;
}

/**
 * Translates the parts of an assistant message into events and remembers how
 * far each has been emitted. A part arrives whole, from an update event or from
 * the transcript, so text is emitted only past what was already emitted and
 * every other part goes through the adapter, which reports each tool call and
 * usage step once. This is the one place that records what has been emitted.
 */
export class TurnProgress {
    private readonly adapter = new OpenCodeEventAdapter();
    /** How many characters of each assistant text part have been emitted. */
    private readonly text = new Map<string, number>();
    private readonly textParts = new Set<string>();
    private turn: string | undefined;

    constructor(private readonly host: Pick<RunnerSessionHost, 'emit'>) {}

    /** The input message of the turn being tracked. */
    get inputMessageId(): string | undefined {
        return this.turn;
    }

    /** How the turn ended according to its own events, if they said. */
    completionReason(): string | undefined {
        return this.adapter.summary().completionReason;
    }

    /** Starts tracking the turn begun by `inputMessageId`. Another turn's ids are forgotten. */
    begin(inputMessageId: string): void {
        if (this.turn === inputMessageId) return;
        this.turn = inputMessageId;
        this.text.clear();
        this.textParts.clear();
        this.adapter.restore({
            startedTools: [],
            completedTools: [],
            finishedSteps: [],
        });
        this.adapter.startTurn();
    }

    snapshot(sessionId: string): OpenCodeProgress {
        return {
            sessionId,
            ...(this.turn ? { inputMessageId: this.turn } : {}),
            text: Object.fromEntries(this.text),
            ...this.adapter.progress(),
        };
    }

    /**
     * Loads saved progress. It refuses progress for another session, or for
     * another turn than `trackedTurn`, the one this session is already tracking.
     */
    restore(
        state: OpenCodeProgress,
        sessionId: string,
        trackedTurn: string | undefined
    ): void {
        if (state.sessionId !== sessionId) {
            throw new Error(
                `OpenCode progress belongs to session ${state.sessionId}, not ${sessionId}`
            );
        }
        if (
            trackedTurn &&
            state.inputMessageId &&
            state.inputMessageId !== trackedTurn
        ) {
            throw new Error(
                `OpenCode progress belongs to turn ${state.inputMessageId}, but this session is tracking turn ${trackedTurn}`
            );
        }
        if (state.inputMessageId && state.inputMessageId !== this.turn) {
            this.begin(state.inputMessageId);
        }
        for (const [part, length] of Object.entries(state.text)) {
            this.text.set(part, Math.max(length, this.text.get(part) ?? 0));
            this.textParts.add(part);
        }
        const current = this.adapter.progress();
        this.adapter.restore({
            startedTools: [
                ...new Set([...current.startedTools, ...state.startedTools]),
            ],
            completedTools: [
                ...new Set([...current.completedTools, ...state.completedTools]),
            ],
            finishedSteps: [
                ...new Set([...current.finishedSteps, ...state.finishedSteps]),
            ],
        });
    }

    /** Whether `partId` is a text part of an assistant message. */
    knowsText(partId: string): boolean {
        return this.textParts.has(partId);
    }

    /** Emits a streamed piece of a text part. */
    async delta(outputId: string, partId: string, delta: string): Promise<void> {
        await this.emitText(outputId, partId, delta, this.text.get(partId) ?? 0);
    }

    /** Translates one native part of `turn` into events. */
    async part(
        turn: ActiveTurn,
        part: Record<string, unknown> | undefined,
        sessionId: string
    ): Promise<void> {
        const partType = string(part?.type);
        if (!part || !partType) return;
        const outputId = turn.assistantOutputIds.get(string(part.messageID) ?? '');
        if (!outputId) return;
        turn.seenActivity = true;
        if (partType === 'text') {
            const partId = string(part.id);
            if (partId) this.textParts.add(partId);
            const text = string(part.text);
            if (!text) return;
            if (!partId) {
                await this.host.emit({
                    type: 'output.text',
                    data: { id: outputId, text },
                });
                return;
            }
            const emitted = this.text.get(partId) ?? 0;
            if (text.length > emitted) {
                await this.emitText(outputId, partId, text.slice(emitted), emitted);
            }
            return;
        }
        const nativeType = partType.replaceAll('-', '_');
        const before = this.adapter.progress();
        const result = this.adapter.consume({
            type: nativeType === 'tool' ? 'tool_use' : nativeType,
            sessionID: sessionId,
            part,
        });
        try {
            for (const draft of result.events) {
                if (draft.type !== 'turn.completed') await this.host.emit(draft);
            }
        } catch (error) {
            // Nothing from this part counts as reported until all of it was.
            this.adapter.restore(before);
            throw error;
        }
    }

    private async emitText(
        outputId: string,
        partId: string,
        text: string,
        offset: number
    ): Promise<void> {
        await this.host.emit({ type: 'output.text', data: { id: outputId, text } });
        this.text.set(partId, offset + text.length);
    }
}
