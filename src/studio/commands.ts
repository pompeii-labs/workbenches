import type { RunStore } from '../runs/store.js';
import type { SessionControl } from '../sessions/control.js';
import type { SessionLifecycle } from '../sessions/lifecycle.js';

export interface StudioCommand {
    kind: 'send' | 'steer' | 'queue' | 'answer' | 'cancel';
    payload: Record<string, unknown>;
    idempotency_key: string;
}

interface StudioCommandResult {
    command: { id: string; status: 'accepted' | 'rejected'; message: string };
}

/**
 * Runs dashboard commands once per run and idempotency key, through session
 * control, and keeps each result for as long as the Studio API server runs.
 */
export class StudioCommands {
    readonly #active = new Map<string, Promise<StudioCommandResult>>();
    readonly #results = new Map<string, StudioCommandResult>();

    constructor(
        private readonly runs: Pick<RunStore, 'read'>,
        private readonly lifecycle: Pick<SessionLifecycle, 'resolve'>,
        private readonly control: Pick<SessionControl, 'send' | 'answer' | 'cancel'>
    ) {}

    async submit(runId: string, body: StudioCommand): Promise<unknown> {
        await this.runs.read(runId);
        const key = `${runId}:${body.idempotency_key}`;
        const existing = this.#results.get(key);
        if (existing) return existing;
        const active = this.#active.get(key);
        if (active) return active;
        const pending = this.execute(runId, body);
        this.#active.set(key, pending);
        try {
            const result = await pending;
            this.#results.set(key, result);
            return result;
        } finally {
            this.#active.delete(key);
        }
    }

    private async execute(
        runId: string,
        body: StudioCommand
    ): Promise<StudioCommandResult> {
        let result: StudioCommandResult;
        let id: string = crypto.randomUUID();
        try {
            const activity = await this.lifecycle.resolve(runId);
            if (body.kind === 'answer') {
                const requestId = body.payload.request_id;
                const response = body.payload.response;
                if (
                    typeof requestId !== 'string' ||
                    (typeof response !== 'string' && !stringMatrix(response))
                )
                    throw new Error('Invalid answer payload');
                await this.control.answer(
                    activity.id,
                    requestId,
                    typeof response === 'string' ? response : JSON.stringify(response)
                );
            } else if (body.kind === 'cancel') {
                if (Object.keys(body.payload).length)
                    throw new Error('Invalid cancel payload');
                await this.control.cancel(activity.id);
            } else {
                const text = body.payload.text;
                if (typeof text !== 'string' || !text)
                    throw new Error('Invalid command text');
                const sent = await this.control.send(activity.id, text, body.kind);
                id = sent.input_id;
            }
            result = { command: { id, status: 'accepted', message: 'Accepted' } };
        } catch (caught) {
            result = {
                command: {
                    id,
                    status: 'rejected',
                    message:
                        caught instanceof Error ? caught.message : 'Command rejected',
                },
            };
        }
        return result;
    }
}

function stringMatrix(value: unknown): value is string[][] {
    return (
        Array.isArray(value) &&
        value.every(
            (row) =>
                Array.isArray(row) && row.every((entry) => typeof entry === 'string')
        )
    );
}
