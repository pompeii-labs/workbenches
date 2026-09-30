import type { WorkbenchEventDraft } from '../../runs/events.js';
import { OpenCodeEventAdapter } from './events.js';
import type { OpenCodeServer } from './server.js';

export class OpenCodeChildren {
    private readonly descendants = new Set<string>();
    private readonly adapters = new Map<string, OpenCodeEventAdapter>();

    constructor(
        private readonly server: OpenCodeServer,
        private readonly root: () => string | undefined
    ) {}

    async observe(info: Record<string, unknown> | undefined): Promise<void> {
        const id = string(info?.id);
        const parent = string(info?.parentID);
        if (id && parent && (await this.owns(parent))) this.descendants.add(id);
    }

    async owns(id: string, visited = new Set<string>()): Promise<boolean> {
        if (id === this.root() || this.descendants.has(id)) return true;
        if (visited.has(id)) return false;
        visited.add(id);
        let info: Record<string, unknown> | undefined;
        try {
            info = record(
                await this.server.requestJson(`/session/${encodeURIComponent(id)}`, {
                    method: 'GET',
                })
            );
        } catch (error) {
            if (
                error instanceof Error &&
                error.message === 'OpenCode request failed with HTTP 404'
            )
                return false;
            throw error;
        }
        const parent = string(info?.parentID);
        if (info?.id !== id || !parent || !(await this.owns(parent, visited)))
            return false;
        this.descendants.add(id);
        return true;
    }

    consume(
        type: string,
        properties: Record<string, unknown>,
        sessionId: string
    ): WorkbenchEventDraft[] {
        if (type !== 'message.part.updated') return [];
        const part = record(properties.part);
        const partType = string(part?.type);
        if (!part || !partType || !['step-finish', 'tool'].includes(partType))
            return [];
        let adapter = this.adapters.get(sessionId);
        if (!adapter) {
            adapter = new OpenCodeEventAdapter();
            this.adapters.set(sessionId, adapter);
        }
        return adapter
            .consume({
                type: partType === 'tool' ? 'tool_use' : 'step_finish',
                sessionID: sessionId,
                part,
            })
            .events.filter((draft) => draft.type !== 'turn.completed')
            .map((draft) => {
                const id = string(draft.data.id);
                return {
                    ...draft,
                    data: {
                        ...draft.data,
                        ...(id ? { id: `${sessionId}:${id}` } : {}),
                        native_session_id: sessionId,
                    },
                };
            });
    }
}

function record(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
}

function string(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}
