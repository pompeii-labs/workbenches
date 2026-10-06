import type { RunnerSessionHost } from '../session.js';
import type { OpenCodeChildren } from './children.js';
import { record, string } from './json.js';
import type { TurnProgress } from './progress.js';
import type { OpenCodeInputRequests } from './requests.js';
import type { OpenCodeServer } from './server.js';
import type { OpenCodeSessionState } from './state.js';
import { outputIdFor } from './transcript.js';

/**
 * Turns the server's native events into the session's events and turn outcomes.
 * It can hold events back while a catch-up reads the transcript, so the catch-up
 * replays them in order afterwards.
 */
export class OpenCodeEventRouter {
    private requests: Promise<void> = Promise.resolve();
    /** Events held while a catch-up reads the transcript. */
    private held: unknown[] | undefined;

    constructor(
        private readonly server: Pick<OpenCodeServer, 'subscribe'>,
        private readonly host: Pick<RunnerSessionHost, 'emit'>,
        private readonly state: OpenCodeSessionState,
        private readonly children: Pick<
            OpenCodeChildren,
            'observe' | 'owns' | 'consume'
        >,
        private readonly input: Pick<OpenCodeInputRequests, 'permission' | 'question'>,
        private readonly emitted: TurnProgress
    ) {}

    /** Opens the event stream, replacing any earlier one. */
    async subscribe(): Promise<void> {
        await this.server.subscribe(
            async (value) => this.consume(value),
            (error) => this.state.streamFailed(error)
        );
    }

    /** Starts holding events instead of handling them. */
    hold(): void {
        this.held = [];
    }

    /** Takes the events held so far, leaving the hold in place. */
    take(): unknown[] {
        return this.held?.splice(0) ?? [];
    }

    /** Ends the hold. Events held and not taken are dropped. */
    release(): void {
        this.held = undefined;
    }

    private async consume(value: unknown): Promise<void> {
        if (this.held) {
            this.held.push(value);
            return;
        }
        await this.handle(value);
    }

    async handle(value: unknown): Promise<void> {
        const state = this.state;
        const event = record(value);
        const type = string(event?.type);
        const properties = record(event?.properties);
        if (!type || !properties) return;

        if (type === 'session.created' || type === 'session.updated') {
            await this.children.observe(record(properties.info));
            return;
        }

        if (type === 'permission.asked' || type === 'question.asked') {
            // An unanswered prompt must not block usage from other native branches.
            const active = state.active;
            this.requests = this.requests
                .then(async () => {
                    if (state.closed || !active || state.active !== active) return;
                    if (type === 'permission.asked')
                        await this.input.permission(active, properties);
                    else await this.input.question(active, properties);
                })
                .catch((error) => {
                    if (state.closed || state.active !== active) return;
                    state.fail(
                        error instanceof Error
                            ? error
                            : new Error('OpenCode input request failed')
                    );
                });
            return;
        }
        if (type === 'question.replied' || type === 'question.rejected') return;

        const sessionId = string(properties.sessionID);
        if (!sessionId) return;
        if (sessionId !== state.sessionId) {
            if (state.active && (await this.children.owns(sessionId))) {
                const drafts = this.children.consume(type, properties, sessionId);
                for (const draft of drafts) await this.host.emit(draft);
            }
            return;
        }
        const active = state.active;
        if (type === 'message.updated') {
            const info = record(properties.info);
            const messageId = string(info?.id);
            const parentId = string(info?.parentID);
            if (
                active &&
                messageId &&
                parentId &&
                info?.role === 'assistant' &&
                active.inputMessageIds.has(parentId)
            ) {
                if (!active.assistantOutputIds.has(messageId)) {
                    active.assistantOutputIds.set(messageId, outputIdFor(messageId));
                }
                active.steering.deliverThrough(parentId);
                active.seenActivity = true;
            }
            return;
        }
        if (!active) return;
        if (type === 'session.error') {
            const error = record(properties.error);
            const errorName = string(error?.name);
            if (active.cancelRequested && errorName === 'MessageAbortedError') {
                return;
            }
            state.failTurn(new Error(sessionFailure(error)));
            return;
        }
        if (type === 'session.status') {
            const status = string(record(properties.status)?.type);
            if (status === 'idle' && (active.seenActivity || active.cancelRequested)) {
                state.finish(
                    active.cancelRequested
                        ? 'cancelled'
                        : this.emitted.completionReason()
                );
            }
            return;
        }
        if (type === 'session.idle') {
            // OpenCode emits this legacy event in addition to session.status=idle.
            // Treating both as completion lets a delayed duplicate from a cancelled
            // turn finish the next turn. The status event is the canonical boundary.
            return;
        }
        if (type === 'message.part.delta') {
            const partId = string(properties.partID);
            const messageId = string(properties.messageID);
            const outputId = messageId
                ? active.assistantOutputIds.get(messageId)
                : undefined;
            if (!outputId || !partId || !this.emitted.knowsText(partId)) return;
            if (properties.field !== 'text') return;
            const delta = string(properties.delta);
            if (!delta) return;
            active.seenActivity = true;
            await this.emitted.delta(outputId, partId, delta);
            return;
        }
        if (type !== 'message.part.updated') {
            await this.host.emit({
                type: 'runner.event',
                data: { native_type: type },
            });
            return;
        }
        await this.emitted.part(active, record(properties.part), sessionId);
    }
}

/**
 * The failure OpenCode reported, such as a provider rejecting the key, so a
 * run that fails before any answer says why. Long token-like strings are
 * redacted, since provider errors can echo credentials.
 */
export function sessionFailure(error: Record<string, unknown> | undefined): string {
    const message =
        string(record(error?.data)?.message) ?? string(error?.message) ?? '';
    const detail = [string(error?.name), message]
        .filter(Boolean)
        .join(': ')
        .replaceAll(/\s+/g, ' ')
        .replaceAll(/[A-Za-z0-9_\-.+/=]{24,}/g, '[redacted]')
        .trim();
    return detail
        ? `OpenCode session failed: ${detail.slice(0, 300)}`
        : 'OpenCode session failed';
}
