import type { CloudRuns } from '../cloud/index.js';
import type { StudioCommandStore } from '../database/studio/commands.js';
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
 * Runs dashboard commands once per run and idempotency key. Local runs go
 * through session control and keep their result; tracked cloud runs go to
 * the cloud API, which owns their idempotency.
 */
export class StudioCommands {
    readonly #active = new Map<string, Promise<unknown>>();

    constructor(
        private readonly runs: Pick<RunStore, 'read'>,
        private readonly results: StudioCommandStore,
        private readonly cloud: Pick<CloudRuns, 'trackedRun' | 'command'>,
        private readonly lifecycle: Pick<SessionLifecycle, 'resolve'>,
        private readonly control: Pick<SessionControl, 'send' | 'answer' | 'cancel'>
    ) {}

    async submit(runId: string, body: StudioCommand): Promise<unknown> {
        const local = await this.runs.read(runId).catch(() => undefined);
        const existing = local
            ? this.results.result(runId, body.idempotency_key)
            : undefined;
        if (existing !== undefined) return existing;
        const key = `${runId}:${body.idempotency_key}`;
        const active = this.#active.get(key);
        if (active) return active;
        const pending = this.execute(runId, body);
        this.#active.set(key, pending);
        try {
            return await pending;
        } finally {
            this.#active.delete(key);
        }
    }

    private async execute(runId: string, body: StudioCommand): Promise<unknown> {
        let result: StudioCommandResult;
        let id: string = crypto.randomUUID();
        const local = await this.runs.read(runId).catch(() => undefined);
        const trackedCloud = local ? undefined : this.cloud.trackedRun(runId);
        try {
            if (trackedCloud) {
                const receipt = await this.cloud.command(
                    trackedCloud.sessionId,
                    body.kind,
                    body.payload,
                    body.idempotency_key
                );
                result = {
                    command: {
                        id: receipt.command.id,
                        status:
                            receipt.command.status === 'rejected'
                                ? 'rejected'
                                : 'accepted',
                        message: receipt.command.reason ?? 'Accepted',
                    },
                };
                return result;
            }
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
        return trackedCloud
            ? result
            : this.results.record(runId, body.idempotency_key, result);
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
