import type {
    RunnerQuestionPrompt,
    RunnerQuestionResponse,
    RunnerSessionHost,
} from '../session.js';

interface PendingDialog {
    release(): void;
    timeout?: ReturnType<typeof setTimeout>;
    deadline?: number;
}

/** Pi extension dialogs use the host question channel, never tool permissions. */
export class PiInputRequests {
    private readonly waiting = new Map<string, PendingDialog>();
    private closed = false;
    private readonly closedRequests = new Set<string>();
    private readonly deadlines = new Map<string, number>();

    constructor(
        private readonly host: Pick<
            RunnerSessionHost,
            'requestQuestion' | 'withdrawRequest'
        >,
        private readonly send: (response: Record<string, unknown>) => Promise<void>,
        /** Withdraws a dialog whose deadline passed while no host was attached. */
        private readonly expire: (id: string) => Promise<void>
    ) {}

    progress(): { closedRequests: string[]; requestDeadlines: Record<string, number> } {
        return {
            closedRequests: [...this.closedRequests],
            requestDeadlines: Object.fromEntries(
                [...this.waiting].flatMap(([id, pending]) =>
                    pending.deadline === undefined ? [] : [[id, pending.deadline]]
                )
            ),
        };
    }

    restore(progress: {
        closedRequests: string[];
        requestDeadlines: Record<string, number>;
    }): void {
        for (const id of progress.closedRequests) this.closedRequests.add(id);
        for (const [id, deadline] of Object.entries(progress.requestDeadlines))
            this.deadlines.set(id, deadline);
    }

    async handle(event: Record<string, unknown>): Promise<void> {
        if (
            this.closed ||
            typeof event.id !== 'string' ||
            this.closedRequests.has(event.id)
        )
            return;
        const prompt = question(event);
        if (!prompt) return;
        const id = event.id;
        const deadline =
            this.deadlines.get(id) ??
            (typeof event.timeout === 'number' &&
            Number.isFinite(event.timeout) &&
            event.timeout > 0
                ? Date.now() + event.timeout
                : undefined);
        this.deadlines.delete(id);
        if (deadline !== undefined && deadline <= Date.now()) {
            this.closedRequests.add(id);
            await this.expire(id);
            return;
        }
        let release = () => {};
        const released = new Promise<undefined>((resolve) => {
            release = () => resolve(undefined);
        });
        const pending: PendingDialog = { release };
        this.waiting.set(id, pending);
        // Pi resolves its timeout locally without emitting a withdrawal event.
        // Mirror the deadline only to stop offering the host's stale request.
        if (deadline !== undefined) {
            pending.deadline = deadline;
            pending.timeout = setTimeout(
                () => {
                    void this.withdraw(id).catch(() => {});
                },
                Math.max(0, deadline - Date.now())
            );
        }
        try {
            const response = await Promise.race([
                this.host
                    .requestQuestion({ id, questions: [prompt] })
                    .catch((): RunnerQuestionResponse => ({ outcome: 'rejected' })),
                released,
            ]);
            if (!response || this.waiting.get(id) !== pending || this.closed) return;
            await this.send({
                type: 'extension_ui_response',
                id,
                ...answer(event.method, prompt, response),
            });
        } finally {
            if (pending.timeout) clearTimeout(pending.timeout);
            if (this.waiting.get(id) === pending) this.waiting.delete(id);
        }
    }

    async withdrawAll(): Promise<void> {
        await Promise.all([...this.waiting.keys()].map((id) => this.withdraw(id)));
    }

    async close(): Promise<void> {
        this.closed = true;
        await this.withdrawAll();
    }

    private async withdraw(id: string): Promise<void> {
        const pending = this.waiting.get(id);
        if (!pending) return;
        this.waiting.delete(id);
        this.closedRequests.add(id);
        if (pending.timeout) clearTimeout(pending.timeout);
        pending.release();
        await this.host.withdrawRequest?.(id);
    }
}

/** Only dialog text and offered labels persist, never editor prefill or UI payloads. */
function question(event: Record<string, unknown>): RunnerQuestionPrompt | undefined {
    const { method, title } = event;
    if (typeof title !== 'string' || !title) return undefined;
    if (!['select', 'confirm', 'input', 'editor'].includes(String(method)))
        return undefined;
    let labels: string[] = [];
    if (method === 'select') {
        if (
            !Array.isArray(event.options) ||
            !event.options.every(
                (value): value is string =>
                    typeof value === 'string' && value.length > 0
            )
        )
            return undefined;
        labels = event.options;
    } else if (method === 'confirm') labels = ['Yes', 'No'];
    return {
        question:
            method === 'confirm' && typeof event.message === 'string' && event.message
                ? `${title}\n\n${event.message}`
                : title,
        options: labels.map((label) => ({ label })),
        multiple: false,
        custom: method === 'input' || method === 'editor',
    };
}

function answer(
    method: unknown,
    prompt: RunnerQuestionPrompt,
    response: RunnerQuestionResponse
): Record<string, unknown> {
    if (
        response.outcome !== 'answered' ||
        response.answers.length !== 1 ||
        response.answers[0]?.length !== 1
    )
        return { cancelled: true };
    const value = response.answers[0][0];
    if (
        value === undefined ||
        (!prompt.custom && !prompt.options.some((option) => option.label === value))
    )
        return { cancelled: true };
    return method === 'confirm' ? { confirmed: value === 'Yes' } : { value };
}
