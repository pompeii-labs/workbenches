import type { WorkbenchEventDraft } from '../../runs/events.js';
import { resultText, ToolDetails } from '../details.js';
import { completionReason } from '../session.js';
import { describeTool, type ToolDescription } from '../tool.js';

export interface PiAdapterResult {
    events: WorkbenchEventDraft[];
    turnCompleted: boolean;
}

export class PiEventAdapter {
    private readonly details: ToolDetails;
    private readonly startedTools = new Set<string>();
    private readonly completedTools = new Set<string>();
    private readonly tools = new Map<
        string,
        {
            name: string;
            description: ToolDescription;
            input: Record<string, unknown> | undefined;
        }
    >();
    private turnCompleted = false;
    private finalText = '';
    private sessionId: string | undefined;
    private completionReason: string | undefined;
    private failureMessage: string | undefined;
    private outputId: string | undefined;

    /** `details` scrubs and bounds tool arguments, results, and patches; a session shares one across turns. */
    constructor(options: { details?: ToolDetails } = {}) {
        this.details = options.details ?? new ToolDetails();
    }

    consume(value: unknown): PiAdapterResult {
        const event = record(value);
        if (!event) return this.native('malformed');
        const type = string(event.type);
        if (!type) return this.native('unknown');

        if (type === 'session') {
            this.sessionId ??= string(event.id);
            return this.result([]);
        }
        if (type === 'message_start') return this.messageStart(event);
        if (type === 'message_update') return this.messageUpdate(event);
        if (type === 'message_end') return this.messageEnd(event);
        if (type === 'tool_execution_start') return this.toolStart(event);
        if (type === 'tool_execution_update') return this.result([]);
        if (type === 'tool_execution_end') return this.toolEnd(event);
        if (type === 'turn_end') {
            this.turnCompleted = true;
            this.completionReason = messageReason(record(event.message)) ?? 'completed';
            return this.result([
                {
                    type: 'turn.completed',
                    data: { reason: this.completionReason },
                },
            ]);
        }
        if (type === 'agent_end' || type === 'agent_start' || type === 'turn_start') {
            return this.result([]);
        }
        if (type === 'extension_error') {
            this.failureMessage ??= 'Pi extension failed';
            return this.result([
                {
                    type: 'runner.event',
                    data: { native_type: type, status: 'error' },
                },
            ]);
        }
        return this.native(type);
    }

    summary() {
        return {
            finalText: this.finalText,
            turnCompleted: this.turnCompleted,
            ...(this.sessionId ? { sessionId: this.sessionId } : {}),
            ...(this.completionReason
                ? { completionReason: this.completionReason }
                : {}),
            ...(this.failureMessage ? { failureMessage: this.failureMessage } : {}),
        };
    }

    private messageUpdate(event: Record<string, unknown>): PiAdapterResult {
        const update = record(event.assistantMessageEvent);
        if (string(update?.type) !== 'text_delta') return this.result([]);
        const text = string(update?.delta);
        if (!text) return this.result([]);
        this.finalText += text;
        this.outputId ??= createOutputId();
        return this.result([
            { type: 'output.text', data: { id: this.outputId, text } },
        ]);
    }

    private messageStart(event: Record<string, unknown>): PiAdapterResult {
        if (string(record(event.message)?.role) === 'assistant') {
            this.outputId = createOutputId();
        }
        return this.result([]);
    }

    private messageEnd(event: Record<string, unknown>): PiAdapterResult {
        const message = record(event.message);
        if (string(message?.role) !== 'assistant') return this.result([]);
        const usage = record(message?.usage);
        const data = usageData(usage);
        const reason = messageReason(message);
        if (reason === 'error' || reason === 'aborted') {
            this.failureMessage ??=
                reason === 'aborted' ? 'Pi turn was aborted' : 'Pi session failed';
        }
        const result = this.result(
            Object.keys(data).length > 1 ? [{ type: 'usage.updated', data }] : []
        );
        this.outputId = undefined;
        return result;
    }

    private toolStart(event: Record<string, unknown>): PiAdapterResult {
        const id = string(event.toolCallId) ?? 'unknown';
        if (this.startedTools.has(id)) return this.result([]);
        this.startedTools.add(id);
        const name = string(event.toolName) ?? 'tool';
        const input = record(event.args);
        const description = describeTool(name, input, undefined);
        this.tools.set(id, { name, description, input });
        return this.result([
            {
                type: 'tool.started',
                data: { id, name, ...description, ...this.details.input(name, input) },
            },
        ]);
    }

    private toolEnd(event: Record<string, unknown>): PiAdapterResult {
        const id = string(event.toolCallId) ?? 'unknown';
        const started = this.tools.get(id);
        const name = string(event.toolName) ?? started?.name ?? 'tool';
        const input = record(event.args) ?? started?.input;
        const description = input
            ? describeTool(name, input, undefined)
            : (started?.description ?? describeTool(name, undefined, undefined));
        const target = description.target;
        const arguments_ = this.details.input(name, input);
        const events: WorkbenchEventDraft[] = [];
        if (!this.startedTools.has(id)) {
            this.startedTools.add(id);
            events.push({
                type: 'tool.started',
                data: { id, name, ...description, ...arguments_ },
            });
        }
        if (!this.completedTools.has(id)) {
            this.completedTools.add(id);
            const failed = event.isError === true;
            events.push({
                type: 'tool.completed',
                data: {
                    id,
                    name,
                    ...description,
                    status: failed ? 'failed' : 'completed',
                    ...(failed
                        ? {
                              error_code: 'runner_error',
                              message: 'Tool failed in runner',
                          }
                        : {}),
                    ...arguments_,
                    ...this.details.output(resultText(record(event.result)?.content)),
                },
            });
            const changed = changedFile(name, target);
            if (!failed && changed) {
                events.push({
                    type: 'file.changed',
                    data: {
                        ...changed,
                        ...piPatch(
                            this.details,
                            name,
                            string(input?.path) ?? changed.path,
                            input,
                            record(record(event.result)?.details)
                        ),
                    },
                });
            }
        }
        return this.result(events);
    }

    private native(nativeType: string): PiAdapterResult {
        return this.result([
            { type: 'runner.event', data: { native_type: nativeType } },
        ]);
    }

    private result(events: WorkbenchEventDraft[]): PiAdapterResult {
        return { events, turnCompleted: this.turnCompleted };
    }
}

function createOutputId(): string {
    return `output_${crypto.randomUUID()}`;
}

function usageData(usage: Record<string, unknown> | undefined) {
    const cost = record(usage?.cost);
    return compact({
        kind: 'delta',
        total_tokens: number(usage?.totalTokens),
        input_tokens: number(usage?.input),
        output_tokens: number(usage?.output),
        cache_read_tokens: number(usage?.cacheRead),
        cache_write_tokens: number(usage?.cacheWrite),
        cost_usd: number(cost?.total),
    });
}

function messageReason(message: Record<string, unknown> | undefined) {
    const reason = string(message?.stopReason) ?? string(message?.reason);
    return reason ? completionReason(reason) : undefined;
}

/**
 * The patch of a Pi edit or write, from the tool's own data. A write is
 * diffed against the run's last write of the file; an edit is applied to that
 * content when known, and otherwise shown as a diff of the replaced text
 * placed at the `firstChangedLine` Pi reports. Anything else has no patch
 * here; the host computes it from the workspace.
 */
function piPatch(
    details: ToolDetails,
    name: string,
    path: string,
    input: Record<string, unknown> | undefined,
    result: Record<string, unknown> | undefined
): ReturnType<ToolDetails['patch']> {
    const tool = name.toLowerCase();
    if (tool === 'write') {
        const content = input?.content;
        return typeof content === 'string' ? details.written(path, content) : {};
    }
    if (tool !== 'edit') return {};
    const edits = piEdits(input);
    if (!edits) {
        details.forget(path);
        return {};
    }
    const edited = details.edited(path, edits);
    if (edited) return details.diff(path, edited.before, edited.after);
    const [only] = edits;
    return edits.length === 1 && only
        ? details.excerpt(
              path,
              only.oldText,
              only.newText,
              number(result?.firstChangedLine)
          )
        : {};
}

/** Pi's edit replacements: one `oldText` and `newText`, or a list of them as `edits`. */
function piEdits(
    input: Record<string, unknown> | undefined
): { oldText: string; newText: string }[] | undefined {
    const list = Array.isArray(input?.edits) ? input.edits : [input];
    const edits = list.flatMap((entry) => {
        const edit = record(entry);
        const oldText = edit?.oldText;
        const newText = edit?.newText;
        return typeof oldText === 'string' && oldText && typeof newText === 'string'
            ? [{ oldText, newText }]
            : [];
    });
    return edits.length > 0 && edits.length === list.length ? edits : undefined;
}

function changedFile(name: string, target: string | undefined) {
    if (!target) return undefined;
    const operation = new Map([
        ['write', 'write'],
        ['edit', 'edit'],
        ['patch', 'edit'],
        ['apply_patch', 'edit'],
    ]).get(name.toLowerCase());
    return operation ? { path: target, operation } : undefined;
}

function compact(value: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(
        Object.entries(value).filter((entry) => entry[1] !== undefined)
    );
}

function record(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
}

function string(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function number(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
