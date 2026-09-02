import type {
    RunnerInput,
    RunnerPermissionDecision,
    RunnerQuestionResponse,
} from '../runners/session.js';
import {
    RunControl,
    type RunControlReceipt,
    type RunControlSubmission,
} from './control.js';
import type { WorkbenchEvent } from './events.js';
import { RunStore, type StoredRun } from './store.js';

export type RunStatus = 'completed' | 'failed' | 'cancelled';

export interface RunResult {
    runId: string;
    status: RunStatus;
}

export interface RunHandle {
    readonly runId: string;
    readonly events: AsyncIterable<WorkbenchEvent>;
    readonly result: Promise<RunResult>;
    send(input: RunnerInput): Promise<RunControlReceipt>;
    steer(input: RunnerInput): Promise<RunControlReceipt>;
    followUp(input: RunnerInput): Promise<RunControlReceipt>;
    cancelTurn(): Promise<RunControlReceipt>;
    respondToPermission(
        id: string,
        decision: RunnerPermissionDecision
    ): Promise<RunControlReceipt>;
    respondToQuestion(
        id: string,
        response: RunnerQuestionResponse
    ): Promise<RunControlReceipt>;
    close(): Promise<RunControlReceipt>;
    cancel(reason?: string): Promise<RunControlReceipt>;
}

export class StoredRunHandle implements RunHandle {
    readonly events: AsyncIterable<WorkbenchEvent>;
    readonly result: Promise<RunResult>;
    private readonly store: RunStore;
    private readonly control: RunControl;
    private submissions: Promise<void> = Promise.resolve();

    constructor(
        home: string,
        readonly runId: string
    ) {
        this.store = new RunStore(home);
        this.control = new RunControl(home, runId);
        this.events = this.store.follow(runId);
        this.result = this.waitForResult();
    }

    send(input: RunnerInput): Promise<RunControlReceipt> {
        return this.submit({ kind: 'send', input });
    }

    steer(input: RunnerInput): Promise<RunControlReceipt> {
        return this.submit({ kind: 'steer', input });
    }

    followUp(input: RunnerInput): Promise<RunControlReceipt> {
        return this.submit({ kind: 'follow_up', input });
    }

    cancelTurn(): Promise<RunControlReceipt> {
        return this.submit({ kind: 'cancel_turn' });
    }

    respondToPermission(
        id: string,
        decision: RunnerPermissionDecision
    ): Promise<RunControlReceipt> {
        const normalized = id.trim();
        if (!normalized) return Promise.reject(new Error('permission ID is required'));
        return this.submit({
            kind: 'permission',
            permission: { id: normalized, decision },
        });
    }

    respondToQuestion(
        id: string,
        response: RunnerQuestionResponse
    ): Promise<RunControlReceipt> {
        const normalized = id.trim();
        if (!normalized) return Promise.reject(new Error('question ID is required'));
        return this.submit({
            kind: 'question',
            question: { id: normalized, response },
        });
    }

    close(): Promise<RunControlReceipt> {
        return this.submit({ kind: 'close' });
    }

    cancel(reason?: string): Promise<RunControlReceipt> {
        return this.submit({ kind: 'cancel', ...(reason ? { reason } : {}) });
    }

    private async submit(submission: RunControlSubmission): Promise<RunControlReceipt> {
        const result = this.submissions.then(
            () => this.submitNow(submission),
            () => this.submitNow(submission)
        );
        this.submissions = result.then(
            () => undefined,
            () => undefined
        );
        return result;
    }

    private async submitNow(
        submission: RunControlSubmission
    ): Promise<RunControlReceipt> {
        const run = await this.store.read(this.runId);
        if (RunStore.isTerminal(run.status)) {
            throw new Error(`Workbench run is already ${run.status}: ${this.runId}`);
        }
        const receipt = await this.control.submit(submission);
        if (receipt.outcome === 'rejected') {
            throw new Error(receipt.error?.message ?? 'Workbench input was rejected');
        }
        return receipt;
    }

    private async waitForResult(): Promise<RunResult> {
        for (;;) {
            const run = await this.store.read(this.runId);
            const result = terminalResult(run);
            if (result) return result;
            this.store.assertWorkerAlive(run);
            await Bun.sleep(50);
        }
    }
}

function terminalResult(run: StoredRun): RunResult | undefined {
    if (run.status === 'completed') return { runId: run.id, status: 'completed' };
    if (run.status === 'failed') return { runId: run.id, status: 'failed' };
    if (run.status === 'cancelled') return { runId: run.id, status: 'cancelled' };
    return undefined;
}
