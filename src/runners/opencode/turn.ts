import type { RunnerTurnResult } from '../session.js';
import { OpenCodeEventAdapter } from './events.js';
import { deferred } from './timing.js';

export interface ActiveTurn {
    adapter: OpenCodeEventAdapter;
    inputMessageIds: Set<string>;
    assistantOutputIds: Map<string, string>;
    steeringDeliveries: Map<string, ReturnType<typeof deferred<void>>>;
    steeringOrder: string[];
    promise: Promise<RunnerTurnResult>;
    resolve: (result: RunnerTurnResult) => void;
    reject: (error: Error) => void;
    cancelRequested: boolean;
    seenActivity: boolean;
    settled: boolean;
}

export function createActiveTurn(messageId: string): ActiveTurn {
    return {
        ...deferred<RunnerTurnResult>(),
        adapter: new OpenCodeEventAdapter(),
        inputMessageIds: new Set([messageId]),
        assistantOutputIds: new Map(),
        steeringDeliveries: new Map(),
        steeringOrder: [],
        cancelRequested: false,
        seenActivity: false,
        settled: false,
    };
}

export class OpenCodeMessageIds {
    private timestamp = 0;
    private sequence = 0;

    next(): string {
        const timestamp = Date.now();
        if (timestamp !== this.timestamp) {
            this.timestamp = timestamp;
            this.sequence = 0;
        }
        this.sequence += 1;
        const ordered =
            (BigInt(timestamp) * 0x1000n + BigInt(this.sequence)) & 0xffffffffffffn;
        const prefix = ordered.toString(16).padStart(12, '0');
        const random = crypto.randomUUID().replaceAll('-', '').slice(0, 14);
        return `msg_${prefix}${random}`;
    }
}
