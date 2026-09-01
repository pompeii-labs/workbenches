import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
    normalizeRunnerInput,
    type RunnerInput,
    type RunnerPermissionDecision,
} from '../runners/session.js';

export type RunControlKind =
    | 'send'
    | 'steer'
    | 'follow_up'
    | 'cancel_turn'
    | 'permission'
    | 'close'
    | 'cancel';

export interface RunControlRequest {
    version: 1;
    id: string;
    kind: RunControlKind;
    submitted_at_ns: string;
    input?: ReturnType<typeof normalizeRunnerInput>;
    permission?: {
        id: string;
        decision: RunnerPermissionDecision;
    };
    reason?: string;
}

export type RunControlDisposition =
    | 'delivered'
    | 'queued'
    | 'cancelled'
    | 'cancellation_requested'
    | 'closed';

export interface RunControlReceipt {
    version: 1;
    id: string;
    kind: RunControlKind;
    outcome: 'accepted' | 'rejected';
    resolved_at: string;
    disposition?: RunControlDisposition;
    error?: {
        code: string;
        message: string;
    };
}

export type RunControlSubmission =
    | { kind: 'send' | 'steer' | 'follow_up'; input: RunnerInput }
    | { kind: 'cancel_turn' | 'close' }
    | { kind: 'cancel'; reason?: string }
    | {
          kind: 'permission';
          permission: { id: string; decision: RunnerPermissionDecision };
      };

interface RunControlOptions {
    pollMilliseconds?: number;
    timeoutMilliseconds?: number;
}

export class RunControl {
    private readonly pollMilliseconds: number;
    private readonly timeoutMilliseconds: number;

    constructor(
        private readonly home: string,
        private readonly runId: string,
        options: RunControlOptions = {}
    ) {
        if (!/^wb_[a-z0-9]{20,64}$/.test(runId)) {
            throw new Error(`Invalid run ID: ${runId}`);
        }
        this.pollMilliseconds = options.pollMilliseconds ?? 50;
        this.timeoutMilliseconds = options.timeoutMilliseconds ?? 30_000;
    }

    async initialize(): Promise<void> {
        await Promise.all([
            mkdir(this.pendingDirectory(), { recursive: true, mode: 0o700 }),
            mkdir(this.activeDirectory(), { recursive: true, mode: 0o700 }),
            mkdir(this.receiptDirectory(), { recursive: true, mode: 0o700 }),
        ]);
    }

    async submit(submission: RunControlSubmission): Promise<RunControlReceipt> {
        await this.initialize();
        const request = this.createRequest(submission);
        await this.writeJson(this.pendingPath(request.id), request);
        return this.waitForReceipt(request);
    }

    async receive(signal?: AbortSignal): Promise<RunControlRequest | undefined> {
        await this.initialize();
        while (!signal?.aborted) {
            const request = await this.claimNext();
            if (request) return request;
            await this.delay(this.pollMilliseconds, signal);
        }
        return undefined;
    }

    async resolve(
        request: RunControlRequest,
        result:
            | { outcome: 'accepted'; disposition: RunControlDisposition }
            | { outcome: 'rejected'; code: string; message: string }
    ): Promise<RunControlReceipt> {
        const receipt: RunControlReceipt = {
            version: 1,
            id: request.id,
            kind: request.kind,
            outcome: result.outcome,
            resolved_at: new Date().toISOString(),
            ...(result.outcome === 'accepted'
                ? { disposition: result.disposition }
                : { error: { code: result.code, message: result.message } }),
        };
        await this.writeJson(this.receiptPath(request.id), receipt);
        await rm(this.activePath(request.id), { force: true });
        return receipt;
    }

    async rejectPending(code: string, message: string): Promise<void> {
        for (;;) {
            const request = await this.claimNext();
            if (!request) return;
            await this.resolve(request, { outcome: 'rejected', code, message });
        }
    }

    private createRequest(submission: RunControlSubmission): RunControlRequest {
        const id = `ctl_${process.hrtime.bigint().toString(36)}_${crypto.randomUUID()}`;
        return {
            version: 1,
            id,
            kind: submission.kind,
            submitted_at_ns: process.hrtime.bigint().toString(),
            ...('input' in submission
                ? { input: normalizeRunnerInput(submission.input) }
                : {}),
            ...('permission' in submission
                ? { permission: submission.permission }
                : {}),
            ...('reason' in submission && submission.reason?.trim()
                ? { reason: submission.reason.trim() }
                : {}),
        };
    }

    private async claimNext(): Promise<RunControlRequest | undefined> {
        const entries = await readdir(this.pendingDirectory()).catch(() => []);
        const requests = await Promise.all(
            entries
                .filter((entry) => entry.endsWith('.json'))
                .map(async (entry) => {
                    try {
                        return {
                            entry,
                            request: await this.readRequest(
                                join(this.pendingDirectory(), entry)
                            ),
                        };
                    } catch (error) {
                        if (isMissing(error)) return undefined;
                        throw error;
                    }
                })
        );
        const available = requests.filter(
            (request): request is NonNullable<typeof request> => request !== undefined
        );
        available.sort((left, right) => {
            const leftTime = BigInt(left.request.submitted_at_ns);
            const rightTime = BigInt(right.request.submitted_at_ns);
            if (leftTime < rightTime) return -1;
            if (leftTime > rightTime) return 1;
            return left.entry.localeCompare(right.entry);
        });
        for (const candidate of available) {
            try {
                await rename(
                    join(this.pendingDirectory(), candidate.entry),
                    this.activePath(candidate.request.id)
                );
                return candidate.request;
            } catch (error) {
                if (isMissing(error)) continue;
                throw error;
            }
        }
        return undefined;
    }

    private async waitForReceipt(
        request: RunControlRequest
    ): Promise<RunControlReceipt> {
        const started = Date.now();
        while (Date.now() - started < this.timeoutMilliseconds) {
            const source = await readFile(this.receiptPath(request.id), 'utf8').catch(
                () => undefined
            );
            if (source) return this.parseReceipt(source, request);
            await this.delay(this.pollMilliseconds);
        }
        throw new Error(`Timed out waiting for Workbench input receipt: ${request.id}`);
    }

    private async readRequest(path: string): Promise<RunControlRequest> {
        const value = JSON.parse(
            await readFile(path, 'utf8')
        ) as Partial<RunControlRequest>;
        if (
            value.version !== 1 ||
            typeof value.id !== 'string' ||
            !runControlKinds.has(value.kind as RunControlKind) ||
            typeof value.submitted_at_ns !== 'string'
        ) {
            throw new Error('Invalid Workbench control request');
        }
        return value as RunControlRequest;
    }

    private parseReceipt(
        source: string,
        request: RunControlRequest
    ): RunControlReceipt {
        const value = JSON.parse(source) as Partial<RunControlReceipt>;
        if (
            value.version !== 1 ||
            value.id !== request.id ||
            value.kind !== request.kind ||
            (value.outcome !== 'accepted' && value.outcome !== 'rejected')
        ) {
            throw new Error(`Invalid Workbench input receipt: ${request.id}`);
        }
        return value as RunControlReceipt;
    }

    private pendingDirectory(): string {
        return join(this.home, 'runs', this.runId, 'control', 'pending');
    }

    private activeDirectory(): string {
        return join(this.home, 'runs', this.runId, 'control', 'active');
    }

    private receiptDirectory(): string {
        return join(this.home, 'runs', this.runId, 'control', 'receipts');
    }

    private pendingPath(id: string): string {
        return join(this.pendingDirectory(), `${id}.json`);
    }

    private activePath(id: string): string {
        return join(this.activeDirectory(), `${id}.json`);
    }

    private receiptPath(id: string): string {
        return join(this.receiptDirectory(), `${id}.json`);
    }

    private async writeJson(path: string, value: unknown): Promise<void> {
        const temporary = `${path}.${crypto.randomUUID()}.tmp`;
        await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
        await rename(temporary, path);
    }

    private async delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
        if (signal?.aborted) return;
        await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, milliseconds);
            signal?.addEventListener(
                'abort',
                () => {
                    clearTimeout(timer);
                    resolve();
                },
                { once: true }
            );
        });
    }
}

const runControlKinds = new Set<RunControlKind>([
    'send',
    'steer',
    'follow_up',
    'cancel_turn',
    'permission',
    'close',
    'cancel',
]);

function isMissing(error: unknown): boolean {
    return (
        error instanceof Error &&
        'code' in error &&
        (error as NodeJS.ErrnoException).code === 'ENOENT'
    );
}
