import { record, string } from './events.js';

/** Interrupt acknowledgements that can outlive the host that sent them. */
export class ClaudeCodeInterrupts {
    private readonly pending = new Map<
        string,
        { resolve: () => void; reject: (error: Error) => void }
    >();

    constructor(
        private readonly write: (value: Record<string, unknown>) => Promise<void>,
        private readonly recovered: (accepted: boolean) => void
    ) {}

    progress(): string[] {
        return [...this.pending.keys()];
    }

    restore(ids: string[]): void {
        for (const id of ids)
            this.pending.set(id, {
                resolve: () => this.recovered(true),
                reject: () => this.recovered(false),
            });
    }

    async send(request: Record<string, unknown>): Promise<void> {
        const id = crypto.randomUUID();
        const acknowledged = new Promise<void>((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
        });
        try {
            await this.write({ type: 'control_request', request_id: id, request });
        } catch (error) {
            this.pending.delete(id);
            throw error;
        }
        return acknowledged;
    }

    reply(event: Record<string, unknown>, commit: (action: () => void) => void): void {
        const response = record(event.response);
        const id = string(response?.request_id);
        const pending = id ? this.pending.get(id) : undefined;
        if (!id || !pending) return;
        commit(() => this.pending.delete(id));
        if (string(response?.subtype) === 'success') pending.resolve();
        else pending.reject(new Error('Claude Code rejected the interrupt'));
    }

    rejectAll(error: Error, retain = false): void {
        for (const pending of this.pending.values()) pending.reject(error);
        if (!retain) this.pending.clear();
    }
}
