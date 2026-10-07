import type { WorkbenchEventDraft } from '../../runs/events.js';
import type {
    RunnerQuestionPrompt,
    RunnerQuestionResponse,
    RunnerSessionHost,
} from '../session.js';

interface ClaudeControlRequest {
    requestId: string;
    subtype: string;
    request: Record<string, unknown>;
}

interface PendingRequest {
    requestId: string;
    kind: 'permission' | 'question';
    settled: boolean;
    cancelled: Promise<void>;
    cancel: () => void;
}

export class ClaudeCodeInputRequests {
    private readonly always = new Set<string>();
    private readonly pending = new Map<string, PendingRequest>();
    private ended = false;
    private releaseEnd: (() => void) | undefined;
    private readonly end = new Promise<void>((resolve) => {
        this.releaseEnd = resolve;
    });

    constructor(
        private readonly host: Pick<
            RunnerSessionHost,
            | 'requestPermission'
            | 'requestQuestion'
            | 'withdrawPermission'
            | 'withdrawQuestion'
        >,
        private readonly write: (value: Record<string, unknown>) => Promise<void>,
        private readonly emit: (
            event: WorkbenchEventDraft
        ) => Promise<void> = async () => {},
        private readonly answerRequests = true
    ) {}

    handle(message: Record<string, unknown>): boolean {
        const control = controlRequest(message);
        if (!control) return false;
        if (control.subtype !== 'can_use_tool') {
            void this.error(
                control.requestId,
                `Workbench does not handle Claude Code control request: ${control.subtype}`
            ).catch(() => {});
            return true;
        }
        const toolName = string(control.request.tool_name);
        const input = record(control.request.input);
        if (!toolName || !input) {
            void this.error(
                control.requestId,
                'Claude Code sent an invalid tool request'
            ).catch(() => {});
            return true;
        }
        let cancel = () => {};
        const pending: PendingRequest = {
            requestId: control.requestId,
            kind: toolName === 'AskUserQuestion' ? 'question' : 'permission',
            settled: false,
            cancelled: new Promise((resolve) => {
                cancel = resolve;
            }),
            cancel: () => cancel(),
        };
        this.pending.set(control.requestId, pending);
        if (!this.answerRequests) {
            void this.deny(pending, `${label(pending.kind)} denied by Workbench`).catch(
                () => {}
            );
            return true;
        }
        const response =
            toolName === 'AskUserQuestion'
                ? this.question(control, pending, input)
                : this.permission(control, pending, toolName, input);
        void response
            .catch(() =>
                this.deny(pending, `${label(pending.kind)} denied by Workbench`)
            )
            .catch(() => {});
        return true;
    }

    cancel(requestId: string): boolean {
        const pending = this.pending.get(requestId);
        if (!pending || pending.settled) return false;
        pending.settled = true;
        pending.cancel();
        this.pending.delete(requestId);
        if (pending.kind === 'permission') {
            this.host.withdrawPermission?.(requestId);
        } else {
            this.host.withdrawQuestion?.(requestId);
        }
        return true;
    }

    async close(denyPending: boolean): Promise<void> {
        if (this.ended) return;
        this.ended = true;
        this.releaseEnd?.();
        if (!denyPending) {
            this.pending.clear();
            return;
        }
        await Promise.allSettled(
            [...this.pending.values()].map((pending) =>
                this.deny(pending, `${label(pending.kind)} denied by Workbench`)
            )
        );
    }

    private async permission(
        control: ClaudeControlRequest,
        pending: PendingRequest,
        toolName: string,
        input: Record<string, unknown>
    ): Promise<void> {
        const resources = permissionResources(input);
        const key = `${toolName}\n${JSON.stringify(input)}`;
        if (this.always.has(key)) {
            await this.emit({
                type: 'runner.event',
                data: { native_type: 'permission.auto_approved' },
            });
            await this.allow(pending, input);
            return;
        }
        const decision = await this.wait(
            this.host.requestPermission({
                id: control.requestId,
                action: toolName,
                resources,
                message: permissionMessage(control.request, toolName, input),
                allowAlways:
                    control.request.suppress_always_allow_rule !== true &&
                    control.request.requires_user_interaction !== true,
            }),
            pending
        );
        if (!decision || pending.settled) return;
        if (decision === 'reject') {
            await this.deny(pending, 'Permission denied by Workbench');
            return;
        }
        if (decision === 'allow_always') this.always.add(key);
        await this.allow(pending, input);
    }

    private async question(
        control: ClaudeControlRequest,
        pending: PendingRequest,
        input: Record<string, unknown>
    ): Promise<void> {
        let questions: RunnerQuestionPrompt[];
        try {
            questions = questionPrompts(input.questions);
        } catch {
            await this.deny(pending, 'Question rejected by Workbench');
            return;
        }
        const response = await this.wait(
            this.host.requestQuestion({ id: control.requestId, questions }),
            pending
        );
        if (!response || pending.settled) return;
        if (response.outcome === 'rejected') {
            await this.deny(pending, 'Question rejected by Workbench');
            return;
        }
        const answers = questionAnswers(questions, response);
        await this.respond(pending, {
            behavior: 'allow',
            updatedInput: { ...input, answers },
        });
    }

    private async wait<T>(
        promise: Promise<T>,
        pending: PendingRequest
    ): Promise<T | undefined> {
        return Promise.race([
            promise,
            this.end.then(() => undefined),
            pending.cancelled.then(() => undefined),
        ]);
    }

    private allow(
        pending: PendingRequest,
        input: Record<string, unknown>
    ): Promise<void> {
        return this.respond(pending, {
            behavior: 'allow',
            updatedInput: input,
        });
    }

    private deny(pending: PendingRequest, message: string): Promise<void> {
        return this.respond(pending, { behavior: 'deny', message });
    }

    private async respond(
        pending: PendingRequest,
        response: Record<string, unknown>
    ): Promise<void> {
        if (pending.settled) return;
        pending.settled = true;
        this.pending.delete(pending.requestId);
        await this.write({
            type: 'control_response',
            response: {
                subtype: 'success',
                request_id: pending.requestId,
                response,
            },
        });
    }

    private error(requestId: string, error: string): Promise<void> {
        return this.write({
            type: 'control_response',
            response: { subtype: 'error', request_id: requestId, error },
        });
    }
}

function controlRequest(
    message: Record<string, unknown>
): ClaudeControlRequest | undefined {
    if (message.type !== 'control_request') return undefined;
    const requestId = string(message.request_id);
    const request = record(message.request);
    const subtype = string(request?.subtype);
    return requestId && request && subtype
        ? { requestId, request, subtype }
        : undefined;
}

function questionPrompts(value: unknown): RunnerQuestionPrompt[] {
    if (!Array.isArray(value) || value.length === 0) {
        throw new Error('Claude Code emitted an invalid question request');
    }
    return value.map((entry) => {
        const question = record(entry);
        const prompt = string(question?.question);
        if (!question || !prompt) {
            throw new Error('Claude Code emitted an invalid question prompt');
        }
        const options = records(question.options).map((entry) => {
            const option = string(entry.label);
            if (!option) throw new Error('Claude Code emitted an invalid option');
            const description = string(entry.description);
            return { label: option, ...(description ? { description } : {}) };
        });
        const header = string(question.header);
        return {
            question: prompt,
            ...(header ? { header } : {}),
            options,
            multiple: question.multiSelect === true,
            custom: question.custom !== false,
        };
    });
}

function questionAnswers(
    questions: RunnerQuestionPrompt[],
    response: Extract<RunnerQuestionResponse, { outcome: 'answered' }>
): Record<string, string> {
    if (response.answers.length !== questions.length) {
        throw new Error('Workbench question response count does not match request');
    }
    return Object.fromEntries(
        questions.map((question, index) => {
            const values = response.answers[index] ?? [];
            if (values.length === 0 || (!question.multiple && values.length > 1)) {
                throw new Error('Workbench question response is invalid');
            }
            const allowed = new Set(question.options.map((option) => option.label));
            const normalized = values.map((value) => value.trim()).filter(Boolean);
            if (
                normalized.length !== values.length ||
                (!question.custom && normalized.some((value) => !allowed.has(value)))
            ) {
                throw new Error(
                    'Workbench question response contains an invalid answer'
                );
            }
            return [question.question, normalized.join(', ')];
        })
    );
}

function permissionResources(input: Record<string, unknown>): string[] {
    for (const key of ['path', 'file_path', 'command', 'url']) {
        const value = string(input[key]);
        if (value) return [value];
    }
    return [];
}

function permissionMessage(
    request: Record<string, unknown>,
    action: string,
    input: Record<string, unknown>
): string {
    const name = action.replaceAll('_', ' ');
    const command = string(input.command);
    const path = string(input.file_path) ?? string(input.path);
    if (
        path &&
        Object.keys(input).length === 1 &&
        !string(request.decision_reason) &&
        !string(request.blocked_path)
    ) {
        return `Allow ${name} for ${preview(path, 320)}?`;
    }
    const lines = [`Allow ${name}?`];
    if (command) lines.push(`Command: ${preview(command, 320)}`);
    if (path) lines.push(`Path: ${preview(path, 320)}`);
    const argumentsValue = record(input.arguments) ?? record(input.args);
    if (argumentsValue) {
        lines.push(`Arguments: ${preview(JSON.stringify(argumentsValue), 320)}`);
    }
    const oldText = string(input.old_string);
    const newText = string(input.new_string) ?? string(input.content);
    if (oldText) lines.push(`Old text: ${preview(oldText, 160)}`);
    if (newText) lines.push(`New text: ${preview(newText, 240)}`);
    const reason = string(request.decision_reason);
    const blockedPath = string(request.blocked_path);
    if (reason) lines.push(`Decision reason: ${preview(reason, 240)}`);
    if (blockedPath) lines.push(`Blocked path: ${preview(blockedPath, 320)}`);
    return preview(lines.join('\n'), 1_024);
}

function preview(value: string, maximum: number): string {
    const clean = [...value]
        .map((character) => {
            const code = character.charCodeAt(0);
            return character === '\n' || (code >= 32 && (code < 127 || code > 159))
                ? character
                : ' ';
        })
        .join('')
        .replace(/[^\S\n]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    return clean.length <= maximum ? clean : `${clean.slice(0, maximum - 3)}...`;
}

function label(kind: PendingRequest['kind']): string {
    return kind === 'permission' ? 'Permission' : 'Question';
}

function records(value: unknown): Record<string, unknown>[] {
    return Array.isArray(value)
        ? value.flatMap((entry) => {
              const found = record(entry);
              return found ? [found] : [];
          })
        : [];
}

function record(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value))
        : undefined;
}

function string(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}
