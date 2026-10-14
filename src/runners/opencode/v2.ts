import { record, string } from './json.js';

/** V2's projected messages mapped to the adapter's internal transcript format. */
export function v2Message(message: Record<string, unknown>, parentID?: string) {
    const id = string(message.id) ?? '';
    const content = Array.isArray(message.content) ? message.content : [];
    const parts: Record<string, unknown>[] = content.map((value, ordinal) => {
        const part = record(value) ?? {};
        return {
            ...part,
            id: v2PartId(id, ordinal),
            messageID: id,
            ...(part.type === 'tool' ? { callID: part.id, tool: part.name } : {}),
        };
    });
    if (message.type === 'assistant' && message.tokens) {
        parts.push({
            id: `${id}:finish`,
            messageID: id,
            type: 'step-finish',
            reason: message.finish,
            cost: message.cost,
            tokens: message.tokens,
        });
    }
    return {
        info: { ...message, role: message.type, parentID },
        parts,
    };
}

export function v2PartId(messageID: string, ordinal: number) {
    return `${messageID}:${ordinal}`;
}

/** Translates the V2 event contract, not V1 plugin events, into internal updates. */
export class OpenCodeV2Events {
    private readonly inputs = new Map<string, string>();
    private readonly messages = new Map<string, Record<string, unknown>>();
    readonly permissions = new Map<string, string>();
    readonly forms = new Map<string, Record<string, unknown>>();

    seed(messages: Record<string, unknown>[], sessionID: string) {
        for (const message of messages) {
            if (message.type === 'user') this.inputs.set(sessionID, String(message.id));
            if (message.type === 'assistant')
                this.messages.set(String(message.id), message);
        }
    }

    consume(value: unknown): unknown[] {
        const event = record(value);
        const data = record(event?.data);
        const type = string(event?.type);
        if (!data || !type) return [];
        const sessionID = string(data.sessionID) ?? '';
        const messageID = string(data.assistantMessageID) ?? '';
        const update = (nativeType: string, properties: unknown) => ({
            type: nativeType,
            properties,
        });
        if (type === 'session.inbox.delivered') {
            this.inputs.set(sessionID, String(data.inboxID));
            return [];
        }
        if (type === 'permission.asked') {
            this.permissions.set(String(data.id), sessionID);
            return [
                update(type, {
                    ...data,
                    permission: data.action,
                    patterns: data.resources,
                    always: data.save,
                }),
            ];
        }
        if (type === 'form.created') {
            const form = record(data.form);
            if (!form) return [];
            this.forms.set(String(form.id), form);
            const fields = Array.isArray(form.fields) ? form.fields : [];
            return [
                update('question.asked', {
                    id: form.id,
                    sessionID: form.sessionID,
                    questions: fields.map((value) => {
                        const field = record(value) ?? {};
                        // Do not silently coerce arbitrary typed or conditional forms.
                        if (
                            !['string', 'multiselect'].includes(String(field.type)) ||
                            field.hidden ||
                            field.when
                        ) {
                            throw new Error(
                                'OpenCode V2 requested an unsupported form field'
                            );
                        }
                        const options = Array.isArray(field.options)
                            ? field.options
                            : [];
                        return {
                            question: field.title ?? field.description ?? form.title,
                            header: field.key,
                            multiple: field.type === 'multiselect',
                            custom: field.custom ?? options.length === 0,
                            options: options.map((value) => {
                                const option = record(value) ?? {};
                                return {
                                    label: option.label ?? option.value,
                                    description: option.description ?? '',
                                };
                            }),
                        };
                    }),
                }),
            ];
        }
        if (type === 'session.created') return [update(type, data)];
        if (type === 'session.execution.failed') {
            return [update('session.error', { sessionID, error: data.error })];
        }
        if (type === 'session.execution.interrupted') {
            return [update('session.interrupted', { sessionID })];
        }
        if (type === 'session.execution.succeeded') {
            return [update('session.succeeded', { sessionID })];
        }
        // V2 execution events are the durable completion boundary. A status
        // notification may arrive late and must not settle the following turn.
        if (type === 'session.status' || type === 'session.idle') return [];
        if (type === 'session.step.started') {
            const message = {
                id: messageID,
                type: 'assistant',
                content: [],
                model: data.model,
            };
            this.messages.set(messageID, message);
            return [
                update('message.updated', {
                    sessionID,
                    info: {
                        ...message,
                        role: 'assistant',
                        parentID: this.inputs.get(sessionID),
                    },
                }),
            ];
        }
        const message = this.messages.get(messageID);
        if (!message) return [];
        const content = message.content as Record<string, unknown>[];
        const ordinal = typeof data.ordinal === 'number' ? data.ordinal : -1;
        if (type === 'session.text.started' || type === 'session.reasoning.started') {
            content[ordinal] = {
                type: type === 'session.text.started' ? 'text' : 'reasoning',
                text: '',
            };
        } else if (
            type === 'session.text.delta' ||
            type === 'session.reasoning.delta'
        ) {
            const part = content[ordinal];
            if (!part) return [];
            part.text = String(part.text ?? '') + String(data.delta ?? '');
        } else if (
            type === 'session.text.ended' ||
            type === 'session.reasoning.ended'
        ) {
            content[ordinal] = {
                type: type === 'session.text.ended' ? 'text' : 'reasoning',
                text: data.text,
            };
        } else if (type === 'session.tool.input.started') {
            content.push({
                type: 'tool',
                id: data.id,
                name: data.name,
                state: { status: 'pending', input: {} },
            });
        } else if (
            type === 'session.tool.called' ||
            type === 'session.tool.success' ||
            type === 'session.tool.failed'
        ) {
            const tool = content.find(
                (part) => part?.type === 'tool' && part.id === data.id
            );
            if (!tool) return [];
            const previous = record(tool.state);
            tool.state = {
                ...previous,
                status:
                    type === 'session.tool.called'
                        ? 'running'
                        : type === 'session.tool.success'
                          ? 'completed'
                          : 'error',
                input: data.input ?? previous?.input ?? {},
                ...(data.content ? { output: data.content } : {}),
                ...(data.error ? { error: data.error } : {}),
            };
        } else if (type === 'session.step.ended' || type === 'session.step.failed') {
            Object.assign(message, {
                tokens: data.tokens,
                cost: data.cost,
                finish: data.finish,
            });
        } else {
            return [];
        }
        return v2Message(message).parts.map((part) =>
            update('message.part.updated', { sessionID, part })
        );
    }
}
