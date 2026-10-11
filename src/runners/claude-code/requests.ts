import type {
    RunnerPermissionDecision,
    RunnerQuestionPrompt,
    RunnerQuestionResponse,
    RunnerSessionHost,
} from '../session.js';
import { record, string } from './events.js';

/** The inner `response` of a `control_response` line. */
export type ClaudeCodeControlResponse =
    | { subtype: 'success'; request_id: string; response: Record<string, unknown> }
    | { subtype: 'error'; request_id: string; error: string };

const QUESTION_TOOL = 'AskUserQuestion';

/**
 * Answers the control requests Claude Code sends over standard input: tool
 * permissions and `AskUserQuestion`. Each is put to the host and the host's
 * answer is returned, never broadened: no `updatedPermissions` is ever sent, so
 * Claude Code's suggested rules never reach the repository or the session.
 * "Allow always" is remembered in memory for the exact tool and input only.
 * Without an answerer every request is denied, unknown requests get an error,
 * and a request Claude Code withdraws gets no reply and is withdrawn from the
 * host.
 */
export class ClaudeCodeInputRequests {
    private readonly allowed = new Set<string>();
    private readonly waiting = new Map<string, () => void>();
    private closed = false;

    constructor(
        private readonly host: Pick<
            RunnerSessionHost,
            'requestPermission' | 'requestQuestion' | 'withdrawRequest'
        >,
        private readonly send: (response: ClaudeCodeControlResponse) => Promise<void>,
        private readonly answersPrompts: boolean
    ) {}

    async handle(requestId: string, request: Record<string, unknown>): Promise<void> {
        if (this.closed) return;
        if (string(request.subtype) !== 'can_use_tool') {
            await this.send({
                subtype: 'error',
                request_id: requestId,
                error: 'Workbench does not answer this control request',
            });
            return;
        }
        if (!this.answersPrompts) {
            await this.deny(
                requestId,
                'Nobody can answer prompts in this session, so the request was denied.'
            );
            return;
        }
        const tool = string(request.tool_name) ?? 'tool';
        const input = record(request.input) ?? {};
        if (tool === QUESTION_TOOL) await this.question(requestId, input);
        else await this.permission(requestId, tool, input, request);
    }

    /**
     * Claude Code no longer needs an answer, so none is sent, and the host
     * stops offering the request.
     */
    async withdraw(requestId: string): Promise<void> {
        const release = this.waiting.get(requestId);
        if (!release) return;
        release();
        await this.host.withdrawRequest?.(requestId);
    }

    close(): void {
        this.closed = true;
        for (const release of this.waiting.values()) release();
    }

    private async permission(
        requestId: string,
        tool: string,
        input: Record<string, unknown>,
        request: Record<string, unknown>
    ): Promise<void> {
        const key = `${tool}\u0000${canonicalJson(input)}`;
        if (this.allowed.has(key)) {
            await this.allow(requestId, input);
            return;
        }
        const allowAlways =
            request.suppress_always_allow_rule !== true &&
            request.requires_user_interaction !== true;
        const resources = permissionResources(tool, request, input);
        const decision = await this.wait<RunnerPermissionDecision>(
            requestId,
            this.host
                .requestPermission({
                    id: requestId,
                    action: tool,
                    resources,
                    message: permissionMessage(tool, request, input),
                    allowAlways,
                })
                .catch(() => 'reject' as const)
        );
        if (!decision) return;
        if (decision.value === 'reject') {
            await this.deny(requestId, 'The user denied this tool call.');
            return;
        }
        if (decision.value === 'allow_always' && allowAlways) this.allowed.add(key);
        await this.allow(requestId, input);
    }

    private async question(
        requestId: string,
        input: Record<string, unknown>
    ): Promise<void> {
        const questions = questionPrompts(input.questions);
        if (!questions) {
            await this.deny(requestId, 'Workbench could not read this question.');
            return;
        }
        const response = await this.wait<RunnerQuestionResponse>(
            requestId,
            this.host
                .requestQuestion({ id: requestId, questions })
                .catch(() => ({ outcome: 'rejected' as const }))
        );
        if (!response) return;
        const answers =
            response.value.outcome === 'answered'
                ? answerMap(questions, response.value.answers)
                : undefined;
        if (!answers) {
            await this.deny(requestId, 'The user did not answer the question.');
            return;
        }
        await this.allow(requestId, { ...input, answers });
    }

    /** The host's answer, or undefined once the request is withdrawn or closed. */
    private async wait<T>(
        requestId: string,
        answer: Promise<T>
    ): Promise<{ value: T } | undefined> {
        let release!: () => void;
        const released = new Promise<undefined>((resolve) => {
            release = () => resolve(undefined);
        });
        this.waiting.set(requestId, release);
        try {
            const result = await Promise.race([
                answer.then((value) => ({ value })),
                released,
            ]);
            return this.closed ? undefined : result;
        } finally {
            this.waiting.delete(requestId);
        }
    }

    private allow(requestId: string, updatedInput: Record<string, unknown>) {
        return this.send({
            subtype: 'success',
            request_id: requestId,
            response: { behavior: 'allow', updatedInput },
        });
    }

    private deny(requestId: string, message: string) {
        return this.send({
            subtype: 'success',
            request_id: requestId,
            response: { behavior: 'deny', message },
        });
    }
}

/**
 * What a permission covers, persisted with the request like its message: an
 * MCP tool's name only, since its input may hold anything, or else the path,
 * command, or URL the tool reaches, bounded to one line.
 */
function permissionResources(
    tool: string,
    request: Record<string, unknown>,
    input: Record<string, unknown>
): string[] {
    if (tool.startsWith('mcp__')) return [singleLine(tool)];
    const resource =
        string(request.blocked_path) ??
        string(input.command) ??
        string(input.file_path) ??
        string(input.notebook_path) ??
        string(input.path) ??
        string(input.url);
    return resource ? [singleLine(resource)] : [];
}

/** The longest any one part of a permission message may be, in characters. */
const PREVIEW_LIMIT = 500;

/**
 * What the person is approving, on one line, phrased as `Allow <tool> for
 * <target>?`: Bash names its full command, Write and Edit their file, and any
 * other tool the path Claude Code blocked or its own path or URL. Then come the
 * blocked path when the target is not it, and Claude Code's reason. File
 * content and tool arguments are never included, because permission messages
 * are persisted and may not hold secrets. Only the request is read, never the
 * environment, and each part is bounded.
 */
function permissionMessage(
    tool: string,
    request: Record<string, unknown>,
    input: Record<string, unknown>
): string {
    const blocked = string(request.blocked_path);
    const reason = string(request.decision_reason);
    const file = string(input.file_path) ?? string(input.notebook_path);
    const writes =
        string(input.content) !== undefined ||
        string(input.new_string) !== undefined ||
        string(input.new_source) !== undefined;
    const mcp = tool.startsWith('mcp__');
    const target = mcp
        ? blocked
        : (string(input.command) ??
          (writes ? file : undefined) ??
          blocked ??
          file ??
          string(input.path) ??
          string(input.url));
    const label = mcp ? tool : tool.replaceAll('_', ' ');
    const details = [
        ...(blocked && blocked !== target ? [detail('Blocked path', blocked)] : []),
        ...(reason ? [detail('Reason', reason)] : []),
    ];
    const head = target
        ? `Allow ${label} for ${singleLine(target)}?`
        : `Allow ${label}?`;
    return [head, ...details].join(' ');
}

function detail(label: string, value: string): string {
    const text = singleLine(value);
    return `${label}: ${text}${/[.!?…]$/.test(text) ? '' : '.'}`;
}

/**
 * Text that cannot break a one-line display: line breaks become a visible
 * mark, other control and format characters (bidirectional overrides among
 * them) become spaces, and the result is cut to the preview limit.
 */
function singleLine(value: string): string {
    const text = value
        .replace(/\r\n|[\r\n\p{Zl}\p{Zp}]/gu, ' ↵ ')
        .replace(/[\p{Cc}\p{Cf}]/gu, ' ');
    const characters = Array.from(text);
    return characters.length > PREVIEW_LIMIT
        ? `${characters.slice(0, PREVIEW_LIMIT - 1).join('')}…`
        : text;
}

function questionPrompts(value: unknown): RunnerQuestionPrompt[] | undefined {
    if (!Array.isArray(value) || value.length === 0) return undefined;
    const prompts: RunnerQuestionPrompt[] = [];
    for (const entry of value) {
        const question = record(entry);
        const text = string(question?.question);
        if (!question || !text || !Array.isArray(question.options)) return undefined;
        const options = [];
        for (const candidate of question.options) {
            const option = record(candidate);
            const label = string(option?.label);
            if (!label) return undefined;
            const description = string(option?.description);
            options.push({ label, ...(description ? { description } : {}) });
        }
        const header = string(question.header);
        prompts.push({
            question: text,
            ...(header ? { header } : {}),
            options,
            multiple: question.multiSelect === true,
            custom: false,
        });
    }
    return prompts;
}

/** Claude Code reads answers keyed by question text, multiple labels comma-joined. */
function answerMap(
    questions: RunnerQuestionPrompt[],
    answers: string[][]
): Record<string, string> | undefined {
    if (answers.length !== questions.length) return undefined;
    const result: Record<string, string> = {};
    for (const [index, question] of questions.entries()) {
        const labels = (answers[index] ?? []).map((label) => label.trim());
        const offered = new Set(question.options.map((option) => option.label));
        if (
            labels.length === 0 ||
            (!question.multiple && labels.length > 1) ||
            labels.some((label) => !offered.has(label))
        ) {
            return undefined;
        }
        result[question.question] = labels.join(', ');
    }
    return result;
}

/** JSON with object keys sorted, so equal inputs compare equal. */
function canonicalJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    const object = record(value);
    if (object) {
        return `{${Object.keys(object)
            .toSorted()
            .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
            .join(',')}}`;
    }
    return JSON.stringify(value) ?? 'null';
}
