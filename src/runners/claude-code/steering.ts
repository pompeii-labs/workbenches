import type { RunnerInputDelivery } from '../session.js';
import { record, string } from './process-support.js';

interface PendingSteer {
    input: string;
    state: 'held' | 'written';
    resolve: () => void;
    reject: (error: Error) => void;
}

export class ClaudeCodeSteering {
    private readonly pending = new Map<string, PendingSteer>();
    private readonly tools = new Set<string>();

    constructor(private readonly write: (value: string) => Promise<void>) {}

    async add(uuid: string, input: string): Promise<RunnerInputDelivery> {
        let resolve = () => {};
        let reject = (_error: Error) => {};
        const delivered = new Promise<void>((accepted, rejected) => {
            resolve = accepted;
            reject = rejected;
        });
        void delivered.catch(() => {});
        this.pending.set(uuid, { input, state: 'held', resolve, reject });
        if (this.tools.size > 0) await this.send(uuid);
        return { delivered };
    }

    beginNativeTurn(): void {
        this.tools.clear();
    }

    async observe(
        message: Record<string, unknown>,
        activeTurn: boolean
    ): Promise<void> {
        if (!activeTurn) return;
        const nativeMessage = record(message.message);
        const content = Array.isArray(nativeMessage?.content)
            ? nativeMessage.content
            : [];
        let toolStarted = false;
        for (const value of content) {
            const block = record(value);
            if (block?.type === 'tool_use') {
                const id = string(block.id);
                if (id) {
                    this.tools.add(id);
                    toolStarted = true;
                }
            }
            if (block?.type === 'tool_result') {
                const id = string(block.tool_use_id);
                if (id) this.tools.delete(id);
            }
        }
        if (toolStarted && this.tools.size > 0) await this.flush();
    }

    started(uuid: string): boolean {
        const steer = this.pending.get(uuid);
        if (steer?.state !== 'written') return false;
        this.pending.delete(uuid);
        steer.resolve();
        return true;
    }

    finished(uuid: string): void {
        const steer = this.pending.get(uuid);
        if (!steer) return;
        this.pending.delete(uuid);
        steer.reject(new Error('Claude Code did not consume steering input'));
    }

    rejectHeld(message: string): void {
        for (const [uuid, steer] of this.pending) {
            if (steer.state !== 'held') continue;
            steer.reject(new Error(message));
            this.pending.delete(uuid);
        }
    }

    rejectCancelled(cancelled: Set<string>, message: string): void {
        this.rejectHeld(message);
        if (cancelled.size === 0) {
            this.rejectAll(message);
            return;
        }
        for (const uuid of cancelled) this.reject(uuid, message);
    }

    rejectAll(message: string): void {
        for (const steer of this.pending.values()) steer.reject(new Error(message));
        this.pending.clear();
    }

    private async flush(): Promise<void> {
        for (const [uuid, steer] of this.pending) {
            if (steer.state === 'held') await this.send(uuid);
        }
    }

    private async send(uuid: string): Promise<void> {
        const steer = this.pending.get(uuid);
        if (steer?.state !== 'held') return;
        steer.state = 'written';
        try {
            await this.write(steer.input);
        } catch (error) {
            this.pending.delete(uuid);
            steer.reject(error instanceof Error ? error : new Error(String(error)));
            throw error;
        }
    }

    private reject(uuid: string, message: string): void {
        const steer = this.pending.get(uuid);
        if (!steer) return;
        this.pending.delete(uuid);
        steer.reject(new Error(message));
    }
}
