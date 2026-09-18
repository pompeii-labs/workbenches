import type {
    RunnerQuestionPrompt,
    RunnerQuestionResponse,
} from '../runners/session.js';
import { RunContinuation } from '../runs/continuation.js';
import type { RunControlReceipt } from '../runs/control.js';
import { StoredRunHandle } from '../runs/handle.js';
import { RunStore } from '../runs/store.js';
import { RunSupervision } from '../runs/supervision.js';
import { SessionLifecycle } from './lifecycle.js';
import { SessionResolver } from './resolver.js';

export interface SessionInputResult {
    session_id: string;
    run_id: string;
    input_id: string;
    after_sequence: number;
    receipt?: RunControlReceipt;
}

export class SessionControl {
    private readonly lifecycle: SessionLifecycle;
    private readonly runs: RunStore;

    constructor(private readonly home: string) {
        this.lifecycle = new SessionLifecycle(home);
        this.runs = new RunStore(home);
    }

    async send(
        id: string,
        task: string,
        delivery: 'send' | 'steer' | 'queue' = 'send'
    ): Promise<SessionInputResult> {
        const activity = await this.lifecycle.resolve(id);
        const run = activity.run;
        if (RunStore.isTerminal(run.status)) {
            if (delivery !== 'send')
                throw new Error(
                    `${delivery} requires an active execution; use send to resume this session`
                );
            const target = await new SessionResolver(this.home).resolve(activity.id);
            try {
                const result = await new RunContinuation(this.home).submit({
                    ...target,
                    task,
                    delivery: 'send',
                    mode: 'detached',
                    environment: process.env,
                });
                return {
                    session_id: result.sessionId,
                    run_id: result.run.id,
                    input_id: result.inputId,
                    after_sequence: result.afterSequence,
                    ...(result.receipt ? { receipt: result.receipt } : {}),
                };
            } finally {
                await target.resolved.cleanup();
            }
        }
        const afterSequence =
            (await this.runs.readEvents(run.id)).at(-1)?.sequence ?? 0;
        const handle = new StoredRunHandle(this.home, run.id);
        const receipt =
            delivery === 'steer'
                ? await handle.steer(task)
                : delivery === 'queue'
                  ? await handle.followUp(task)
                  : await handle.send(task);
        return {
            session_id: activity.id,
            run_id: run.id,
            input_id: receipt.id,
            after_sequence: afterSequence,
            receipt,
        };
    }

    async answer(
        id: string,
        requestId: string,
        response: string
    ): Promise<SessionInputResult> {
        const activity = await this.lifecycle.resolve(id);
        const view = await new RunSupervision(this.home).snapshot(activity.run);
        const request = view.pending_requests.find(
            (pending) => pending.id === requestId
        );
        if (!request)
            throw new Error(
                `Input request is unknown or no longer pending: ${requestId}`
            );
        if (request.kind === 'authentication')
            throw new Error(
                'Complete authentication using the reported URL and instructions; answer cannot supply credentials'
            );
        const handle = new StoredRunHandle(this.home, activity.run.id);
        let receipt: RunControlReceipt;
        if (request.kind === 'permission') {
            const decision =
                response === 'allow'
                    ? 'allow_once'
                    : response === 'deny'
                      ? 'reject'
                      : response;
            if (
                (decision !== 'allow_once' &&
                    decision !== 'allow_always' &&
                    decision !== 'reject') ||
                !Array.isArray(request.details.options) ||
                !request.details.options.includes(decision)
            ) {
                throw new Error(
                    'Permission response must be allow, deny, or an offered permission option'
                );
            }
            receipt = await handle.respondToPermission(requestId, decision);
        } else {
            receipt = await handle.respondToQuestion(
                requestId,
                questionResponse(request.details.questions, response)
            );
        }
        return {
            session_id: activity.id,
            run_id: activity.run.id,
            input_id: receipt.id,
            after_sequence: view.sequence,
            receipt,
        };
    }
}

function questionResponse(value: unknown, response: string): RunnerQuestionResponse {
    if (response === '--reject') return { outcome: 'rejected' };
    if (!Array.isArray(value) || value.length === 0)
        throw new Error('Question request has no prompts');
    const questions = value as RunnerQuestionPrompt[];
    let answers: unknown = [[response]];
    if (response.trimStart().startsWith('[')) {
        try {
            answers = JSON.parse(response);
        } catch {
            throw new Error('Question response must be valid JSON string arrays');
        }
    }
    if (!Array.isArray(answers) || answers.length !== questions.length)
        throw new Error('Answer every question using a JSON array of string arrays');
    for (let index = 0; index < questions.length; index++) {
        const question = questions[index];
        const answer: unknown = answers[index];
        if (
            !question ||
            !Array.isArray(answer) ||
            !answer.length ||
            (!question.multiple && answer.length !== 1) ||
            !answer.every(
                (entry) =>
                    typeof entry === 'string' &&
                    entry.trim() &&
                    (question.custom ||
                        question.options.some((option) => option.label === entry))
            )
        ) {
            throw new Error(
                'Question response does not match the offered options or selection count'
            );
        }
    }
    return { outcome: 'answered', answers: answers as string[][] };
}
