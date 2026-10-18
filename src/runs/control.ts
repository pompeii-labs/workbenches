import type { Connection } from '../database/connection.js';
import { DatabaseConstraintError } from '../database/error.js';
import { RowReader } from '../database/rows.js';
import { RunControlStore } from '../database/runs/controls.js';
import {
    normalizeRunnerInput,
    type RunnerInput,
    type RunnerPermissionDecision,
    type RunnerQuestionResponse,
} from '../runners/session.js';

export type RunControlKind =
    | 'attach_client'
    | 'detach_client'
    | 'send'
    | 'steer'
    | 'follow_up'
    | 'cancel_turn'
    | 'permission'
    | 'question'
    | 'close'
    | 'cancel';

export interface RunControlRequest {
    version: 1;
    id: string;
    kind: RunControlKind;
    submitted_at_ns: string;
    input?: ReturnType<typeof normalizeRunnerInput>;
    permission?: {
        id: string;
        decision: RunnerPermissionDecision;
    };
    question?: {
        id: string;
        response: RunnerQuestionResponse;
    };
    reason?: string;
    client_id?: string;
    promote_queued_steers?: boolean;
}

export type RunControlDisposition =
    | 'attached'
    | 'detached'
    | 'delivered'
    | 'queued'
    | 'cancelled'
    | 'already_idle'
    | 'cancellation_requested'
    | 'closed';

export interface RunControlReceipt {
    version: 1;
    id: string;
    kind: RunControlKind;
    outcome: 'accepted' | 'rejected';
    resolved_at: string;
    disposition?: RunControlDisposition;
    error?: {
        code: string;
        message: string;
    };
}

export type RunControlSubmission =
    | { kind: 'attach_client' | 'detach_client'; clientId: string }
    | { kind: 'send' | 'steer' | 'follow_up'; input: RunnerInput }
    | { kind: 'cancel_turn'; promoteQueuedSteers?: boolean }
    | { kind: 'close' }
    | { kind: 'cancel'; reason?: string }
    | {
          kind: 'permission';
          permission: { id: string; decision: RunnerPermissionDecision };
      }
    | {
          kind: 'question';
          question: { id: string; response: RunnerQuestionResponse };
      };

interface RunControlOptions {
    pollMilliseconds?: number;
    timeoutMilliseconds?: number;
}

/**
 * The durable request channel between a client and the process running a
 * session. Requests and receipts are rows. A request is claimed atomically, so
 * no two receivers ever hold the same one.
 */
export class RunControl {
    private readonly pollMilliseconds: number;
    private readonly timeoutMilliseconds: number;
    private readonly store: RunControlStore;

    constructor(
        private readonly connection: Pick<
            Connection,
            'run' | 'one' | 'transaction' | 'changeToken' | 'delay'
        >,
        private readonly runId: string,
        options: RunControlOptions = {}
    ) {
        if (!/^wb_[a-z0-9]{20,64}$/.test(runId)) {
            throw new Error(`Invalid run ID: ${runId}`);
        }
        this.pollMilliseconds = options.pollMilliseconds ?? 50;
        this.timeoutMilliseconds = options.timeoutMilliseconds ?? 30_000;
        this.store = new RunControlStore(connection);
    }

    async submit(submission: RunControlSubmission): Promise<RunControlReceipt> {
        const request = this.createRequest(submission);
        try {
            this.store.enqueue(
                this.runId,
                request.id,
                request.kind,
                JSON.stringify(request)
            );
        } catch (error) {
            if (
                error instanceof DatabaseConstraintError &&
                error.code === 'foreign_key'
            )
                throw new Error(`Workbench run does not exist: ${this.runId}`);
            throw error;
        }
        return this.waitForReceipt(request);
    }

    async receive(signal?: AbortSignal): Promise<RunControlRequest | undefined> {
        while (!signal?.aborted) {
            // Read the change signal before claiming so a write in between is not missed.
            const token = this.connection.changeToken();
            const request = this.claimNext();
            if (request) return request;
            while (!signal?.aborted) {
                await this.connection.delay(this.pollMilliseconds, signal);
                if (this.connection.changeToken() !== token) break;
            }
        }
        return undefined;
    }

    async resolve(
        request: RunControlRequest,
        result:
            | { outcome: 'accepted'; disposition: RunControlDisposition }
            | { outcome: 'rejected'; code: string; message: string }
    ): Promise<RunControlReceipt> {
        const receipt: RunControlReceipt = {
            version: 1,
            id: request.id,
            kind: request.kind,
            outcome: result.outcome,
            resolved_at: new Date().toISOString(),
            ...(result.outcome === 'accepted'
                ? { disposition: result.disposition }
                : { error: { code: result.code, message: result.message } }),
        };
        this.store.settle(this.runId, request.id, JSON.stringify(receipt));
        return receipt;
    }

    async rejectPending(code: string, message: string): Promise<void> {
        for (;;) {
            const request = this.claimNext();
            if (!request) return;
            await this.resolve(request, { outcome: 'rejected', code, message });
        }
    }

    private createRequest(submission: RunControlSubmission): RunControlRequest {
        const id = `ctl_${process.hrtime.bigint().toString(36)}_${crypto.randomUUID()}`;
        return {
            version: 1,
            id,
            kind: submission.kind,
            submitted_at_ns: process.hrtime.bigint().toString(),
            ...('input' in submission
                ? { input: normalizeRunnerInput(submission.input) }
                : {}),
            ...('permission' in submission
                ? { permission: submission.permission }
                : {}),
            ...('question' in submission ? { question: submission.question } : {}),
            ...('promoteQueuedSteers' in submission && submission.promoteQueuedSteers
                ? { promote_queued_steers: true }
                : {}),
            ...('reason' in submission && submission.reason?.trim()
                ? { reason: submission.reason.trim() }
                : {}),
            ...('clientId' in submission
                ? { client_id: submission.clientId.trim() }
                : {}),
        };
    }

    private claimNext(): RunControlRequest | undefined {
        const payload = this.store.claimNext(this.runId);
        return payload === undefined ? undefined : this.parseRequest(payload);
    }

    private async waitForReceipt(
        request: RunControlRequest
    ): Promise<RunControlReceipt> {
        const started = Date.now();
        let seen = '';
        while (Date.now() - started < this.timeoutMilliseconds) {
            const token = this.connection.changeToken();
            if (token !== seen) {
                seen = token;
                const payload = this.store.receipt(request.id);
                if (payload !== undefined) return this.parseReceipt(payload, request);
            }
            await this.connection.delay(this.pollMilliseconds);
        }
        throw new Error(this.timeoutMessage(request.kind));
    }

    private parseRequest(source: unknown): RunControlRequest {
        const value = this.parseJson(source);
        if (
            !RowReader.isRecord(value) ||
            value.version !== 1 ||
            typeof value.id !== 'string' ||
            typeof value.kind !== 'string' ||
            !runControlKinds.has(value.kind as RunControlKind) ||
            typeof value.submitted_at_ns !== 'string'
        ) {
            throw new Error('Invalid Workbench control request');
        }
        return value as unknown as RunControlRequest;
    }

    private parseReceipt(
        source: unknown,
        request: RunControlRequest
    ): RunControlReceipt {
        const value = this.parseJson(source);
        if (
            !RowReader.isRecord(value) ||
            value.version !== 1 ||
            value.id !== request.id ||
            value.kind !== request.kind ||
            (value.outcome !== 'accepted' && value.outcome !== 'rejected')
        ) {
            throw new Error('The Workbench returned an invalid input acknowledgement');
        }
        return value as unknown as RunControlReceipt;
    }

    private parseJson(source: unknown): unknown {
        if (typeof source !== 'string') return undefined;
        try {
            return JSON.parse(source);
        } catch {
            return undefined;
        }
    }

    private timeoutMessage(kind: RunControlKind): string {
        if (kind === 'cancel_turn') {
            return 'The Workbench did not acknowledge cancellation. Inspect the session with wb ps or stop it with wb kill <session-id>.';
        }
        return 'The Workbench did not acknowledge the message. The session may still be active; inspect it with wb ps.';
    }
}

const runControlKinds = new Set<RunControlKind>([
    'attach_client',
    'detach_client',
    'send',
    'steer',
    'follow_up',
    'cancel_turn',
    'permission',
    'question',
    'close',
    'cancel',
]);
