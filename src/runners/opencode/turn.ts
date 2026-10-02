import type { RunnerTurnResult } from '../session.js';
import { deferred } from './timing.js';

export interface ActiveTurn {
    /** The native id of the message that began the turn. */
    inputMessageId: string;
    /** Every input of the turn: that message and the steering inputs sent after it. */
    inputMessageIds: Set<string>;
    assistantOutputIds: Map<string, string>;
    steering: TurnSteering;
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
        inputMessageId: messageId,
        inputMessageIds: new Set([messageId]),
        assistantOutputIds: new Map(),
        steering: new TurnSteering(),
        cancelRequested: false,
        seenActivity: false,
        settled: false,
    };
}

/**
 * The inputs sent to a running turn that the model has not consumed yet. Each
 * is delivered when OpenCode starts answering it or a later input, and fails if
 * the turn ends first.
 */
export class TurnSteering {
    private readonly deliveries = new Map<string, ReturnType<typeof deferred<void>>>();
    private order: string[] = [];

    /** Tracks an input and returns a promise that settles when it is delivered. */
    add(messageId: string): Promise<void> {
        const delivery = deferred<void>();
        // A caller that never awaits the delivery must not surface its failure.
        void delivery.promise.catch(() => {});
        this.deliveries.set(messageId, delivery);
        this.order.push(messageId);
        return delivery.promise;
    }

    has(messageId: string): boolean {
        return this.deliveries.has(messageId);
    }

    /** Resolves the inputs up to and including `messageId`. */
    deliverThrough(messageId: string): void {
        const boundary = this.order.indexOf(messageId);
        if (boundary === -1) return;
        for (const id of this.order.splice(0, boundary + 1)) {
            const delivery = this.deliveries.get(id);
            this.deliveries.delete(id);
            delivery?.resolve(undefined);
        }
    }

    /** Fails one input that could not be sent. */
    drop(messageId: string, error: Error): void {
        this.order = this.order.filter((id) => id !== messageId);
        const delivery = this.deliveries.get(messageId);
        this.deliveries.delete(messageId);
        delivery?.reject(error);
    }

    /** Fails every input not yet delivered. */
    rejectAll(error: Error): void {
        for (const delivery of this.deliveries.values()) delivery.reject(error);
        this.deliveries.clear();
        this.order.length = 0;
    }
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
