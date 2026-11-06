import { string } from './rpc.js';

interface PendingResponse {
    command: string;
    recovered: boolean;
    resolve: (value: Record<string, unknown>) => void;
    reject: (error: Error) => void;
}

/** Native RPC acknowledgements, including commands sent before the host attached. */
export class PiResponses {
    private readonly waiting = new Map<string, PendingResponse>();

    progress(): Array<{ id: string; command: string }> {
        return [...this.waiting].map(([id, pending]) => ({
            id,
            command: pending.command,
        }));
    }

    restore(commands: Array<{ id: string; command: string }>): void {
        for (const { id, command } of commands)
            this.waiting.set(id, {
                command,
                recovered: true,
                resolve: () => {},
                reject: () => {},
            });
    }

    start(id: string, command: string): Promise<Record<string, unknown>> {
        return new Promise((resolve, reject) => {
            this.waiting.set(id, { command, recovered: false, resolve, reject });
        });
    }

    forget(id: string): void {
        this.waiting.delete(id);
    }

    consume(
        event: Record<string, unknown>,
        commit: (action: () => void) => void
    ): { command: string; recovered: boolean } | undefined {
        const id = string(event.id);
        const pending = id ? this.waiting.get(id) : undefined;
        if (!id || !pending) return undefined;
        commit(() => this.waiting.delete(id));
        if (event.success === true) pending.resolve(event);
        else pending.reject(new Error(`Pi command failed: ${pending.command}`));
        return { command: pending.command, recovered: pending.recovered };
    }

    rejectAll(error: Error, retain = false): void {
        for (const pending of this.waiting.values()) pending.reject(error);
        if (!retain) this.waiting.clear();
    }
}
