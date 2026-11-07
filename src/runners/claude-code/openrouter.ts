import type { WorkbenchEventDraft } from '../../runs/events.js';
import { WORKBENCH_USER_AGENT } from '../../user-agent.js';
import { record } from './events.js';

/** How the host reaches OpenRouter and waits between attempts. */
export interface OpenRouterAccess {
    fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
    sleep(milliseconds: number, signal?: AbortSignal): Promise<void>;
}

/** The platform's own fetch and timers. */
export const PLATFORM_OPENROUTER_ACCESS: OpenRouterAccess = {
    fetch: (input, init) => fetch(input, init),
    sleep: (milliseconds, signal) =>
        new Promise((resolve, reject) => {
            signal?.throwIfAborted();
            const abort = () => {
                clearTimeout(timer);
                reject(signal?.reason);
            };
            const timer = setTimeout(() => {
                signal?.removeEventListener('abort', abort);
                resolve();
            }, milliseconds);
            signal?.addEventListener('abort', abort, { once: true });
        }),
};

// https://openrouter.ai/docs/api/api-reference/generations/get-generation
const GENERATION_URL = 'https://openrouter.ai/api/v1/generation';
const GENERATION_ID = /^gen-[0-9A-Za-z-]{1,124}$/u;

/**
 * Waits before each new attempt. A generation can be briefly not found right
 * after its response, so a lookup gives up after about sixty seconds of waits.
 */
const backoff = [
    250, 500, 1_000, 2_000, 4_000, 8_000, 8_000, 8_000, 8_000, 8_000, 8_000, 4_000,
];
const requestTimeoutMs = 5_000;

/**
 * Reads what OpenRouter charged for each generation Claude Code reported, with
 * the route's own key. Holds the key; never logs or echoes it.
 */
export class OpenRouterGenerations {
    private readonly fetcher: OpenRouterAccess['fetch'];

    constructor(
        private readonly key: string,
        private readonly access: OpenRouterAccess
    ) {
        // Some runtimes require Web platform functions to run with an undefined
        // `this`, so never call the injected function as a method.
        const fetcher = access.fetch;
        this.fetcher = (input, init) => fetcher(input, init);
    }

    async total(
        generations: string[],
        signal?: AbortSignal
    ): Promise<number | undefined> {
        try {
            const costs = await Promise.allSettled(
                generations.map((id) => this.cost(id, signal))
            );
            let total = 0;
            for (const cost of costs) {
                if (cost.status === 'rejected') return undefined;
                total += cost.value;
            }
            return total;
        } catch {
            return undefined;
        }
    }

    /** The USD cost OpenRouter charged for generation `id`. */
    async cost(id: string, cancellation?: AbortSignal): Promise<number> {
        if (!GENERATION_ID.test(id)) {
            throw new Error(
                'Claude Code reported a request id that is not an OpenRouter generation'
            );
        }
        const url = new URL(GENERATION_URL);
        url.searchParams.set('id', id);
        const deadline = AbortSignal.timeout(60_000);
        const signal = cancellation
            ? AbortSignal.any([cancellation, deadline])
            : deadline;
        for (let attempt = 0; ; attempt++) {
            signal.throwIfAborted();
            let response: Response | undefined;
            try {
                response = await this.fetcher(url, {
                    headers: {
                        Authorization: `Bearer ${this.key}`,
                        Accept: 'application/json',
                        'User-Agent': WORKBENCH_USER_AGENT,
                    },
                    signal: AbortSignal.any([
                        signal,
                        AbortSignal.timeout(requestTimeoutMs),
                    ]),
                });
            } catch (error) {
                // A request that ran out of time would only time out again.
                if (timedOut(error)) throw failure(id, 'timed out');
            }
            if (response?.ok) {
                const body: unknown = await response.json().catch(() => {});
                // A record without a finish reason is not complete: it reports
                // no tokens and no cost even when the request was billed.
                if (record(record(body)?.data)?.finish_reason != null)
                    return charged(id, body);
            }
            const status = response?.status;
            const retryable =
                status === undefined ||
                response?.ok ||
                status === 404 ||
                status === 429 ||
                status >= 500;
            if (!response?.bodyUsed) await response?.body?.cancel().catch(() => {});
            const delay = backoff[attempt];
            if (!retryable || delay === undefined) {
                throw failure(
                    id,
                    response?.ok
                        ? 'incomplete'
                        : status === undefined
                          ? 'no response'
                          : String(status)
                );
            }
            await this.access.sleep(delay, signal);
        }
    }
}

/** Owns late turn charges until normal shutdown drains them or `cancel` drops them. */
export class OpenRouterCharges {
    private readonly generations: OpenRouterGenerations;
    private readonly pending = new Set<Promise<void>>();
    /** The generations of each charge whose usage event the host has not received. */
    private readonly unreported = new Set<string[]>();
    private readonly cancellation = new AbortController();

    constructor(
        key: string,
        access: OpenRouterAccess,
        private readonly emit: (event: WorkbenchEventDraft) => Promise<void>
    ) {
        this.generations = new OpenRouterGenerations(key, access);
    }

    collect(ids: string[]): void {
        const charge = [...ids];
        this.unreported.add(charge);
        const lookup = this.generations
            .total(charge, this.cancellation.signal)
            .then(async (cost) => {
                if (cost !== undefined && !this.cancellation.signal.aborted) {
                    await this.emit({
                        type: 'usage.updated',
                        data: { kind: 'delta', cost_usd: cost },
                    });
                }
                // Dropped as soon as the event lands, so progress read after it
                // never reads the charge again. A failed `emit` keeps it.
                this.unreported.delete(charge);
            })
            .catch(() => {});
        this.pending.add(lookup);
        void lookup.finally(() => this.pending.delete(lookup));
    }

    progress(): string[][] {
        return [...this.unreported].map((ids) => [...ids]);
    }

    cancel(): void {
        this.cancellation.abort();
    }

    async finish(): Promise<void> {
        if (!this.cancellation.signal.aborted) await Promise.all(this.pending);
    }
}

function charged(id: string, body: unknown): number {
    const cost = record(record(body)?.data)?.total_cost;
    if (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0) {
        throw failure(id, 'no charged cost');
    }
    return cost;
}

function failure(id: string, status: string): Error {
    return new Error(`OpenRouter generation ${id} was not read: ${status}`);
}

function timedOut(error: unknown): boolean {
    return error instanceof DOMException && error.name === 'TimeoutError';
}
