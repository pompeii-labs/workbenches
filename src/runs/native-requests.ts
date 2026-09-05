import type {
    RunnerPermissionDecision,
    RunnerPermissionRequest,
    RunnerQuestionRequest,
    RunnerQuestionResponse,
} from '../runners/session.js';

export class NativeRequests {
    readonly #permissions = new Map<
        string,
        (decision: RunnerPermissionDecision) => void
    >();
    readonly #questions = new Map<string, (response: RunnerQuestionResponse) => void>();

    waitForPermission(
        request: RunnerPermissionRequest
    ): Promise<RunnerPermissionDecision> {
        return new Promise((resolve) => {
            this.#permissions.get(request.id)?.('reject');
            this.#permissions.set(request.id, resolve);
        });
    }

    answerPermission(id: string, decision: RunnerPermissionDecision): boolean {
        const resolve = this.#permissions.get(id);
        if (!resolve) return false;
        this.#permissions.delete(id);
        resolve(decision);
        return true;
    }

    waitForQuestion(request: RunnerQuestionRequest): Promise<RunnerQuestionResponse> {
        return new Promise((resolve) => {
            this.#questions.get(request.id)?.({ outcome: 'rejected' });
            this.#questions.set(request.id, resolve);
        });
    }

    answerQuestion(id: string, response: RunnerQuestionResponse): boolean {
        const resolve = this.#questions.get(id);
        if (!resolve) return false;
        this.#questions.delete(id);
        resolve(response);
        return true;
    }

    rejectPermissions(): void {
        for (const resolve of this.#permissions.values()) resolve('reject');
        this.#permissions.clear();
    }

    rejectQuestions(): void {
        for (const resolve of this.#questions.values()) {
            resolve({ outcome: 'rejected' });
        }
        this.#questions.clear();
    }

    rejectAll(): void {
        this.rejectPermissions();
        this.rejectQuestions();
    }
}
