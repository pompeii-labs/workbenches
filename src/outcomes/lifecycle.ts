import type { PreparedRuntime } from '../runtimes/contracts.js';
import type {
    OutcomeApplicationState,
    OutcomeCompleteness,
    RunOutcome,
} from './contracts.js';
import { OutcomeOutput } from './output.js';
import { restoreSessionArtifacts } from './resume.js';
import { OutcomeStore } from './store.js';

export interface OutcomeLifecycleOptions {
    home: string;
    runId: string;
    resumeSessionId?: string;
    now?: () => Date;
    onAvailable?: (
        outcome: RunOutcome,
        applicationState: OutcomeApplicationState
    ) => Promise<void> | void;
}

export class OutcomeLifecycle {
    readonly output: OutcomeOutput;
    private outcome: RunOutcome | undefined;
    private collection: Promise<RunOutcome | undefined> | undefined;
    private publication: Promise<void> | undefined;
    private applicationState: OutcomeApplicationState | undefined;
    private queue: Promise<unknown> = Promise.resolve();
    private initialFingerprint: string | undefined;
    private checkpointResult:
        | {
              fingerprint: string;
              outcome: RunOutcome;
              published: boolean;
          }
        | undefined;

    private constructor(
        private readonly options: OutcomeLifecycleOptions,
        output: OutcomeOutput
    ) {
        this.output = output;
    }

    static async create(options: OutcomeLifecycleOptions): Promise<OutcomeLifecycle> {
        const output = await OutcomeOutput.create(options.home, options.runId);
        const lifecycle = new OutcomeLifecycle(options, output);
        try {
            if (
                options.resumeSessionId &&
                (await restoreSessionArtifacts(
                    options.home,
                    options.resumeSessionId,
                    options.runId,
                    output
                )) > 0
            ) {
                const store = new OutcomeStore(options.home);
                try {
                    lifecycle.initialFingerprint = JSON.stringify(
                        await output.collect(store)
                    );
                } finally {
                    await store.close();
                }
            }
            return lifecycle;
        } catch (error) {
            await output.cleanup();
            throw error;
        }
    }

    async collect(
        runtime: PreparedRuntime | undefined,
        completeness: OutcomeCompleteness
    ): Promise<RunOutcome | undefined> {
        if (this.outcome) {
            await runtime?.finalizeOutcome?.();
            await this.publish();
            return this.outcome;
        }
        if (!this.collection) {
            this.collection = this.enqueue(() =>
                this.collectOnce(runtime, completeness)
            ).catch((error) => {
                this.collection = undefined;
                throw error;
            });
        }
        return this.collection;
    }

    checkpoint(
        runtime: PreparedRuntime | undefined,
        turnIndex: number
    ): Promise<RunOutcome | undefined> {
        if (!Number.isSafeInteger(turnIndex) || turnIndex < 1) {
            return Promise.reject(
                new Error('Outcome turn index must be a positive safe integer')
            );
        }
        if (this.collection || this.outcome) {
            return Promise.reject(
                new Error('Cannot snapshot results after final collection has started')
            );
        }
        return this.enqueue(async () => {
            // Retry publication of committed bytes before collecting another revision.
            const previous = this.checkpointResult;
            if (previous && !previous.published) {
                await this.options.onAvailable?.(previous.outcome, 'present');
                previous.published = true;
            }
            const store = new OutcomeStore(this.options.home);
            try {
                const output =
                    (await runtime?.collectOutput?.(store)) ??
                    (await this.output.collect(store));
                const fingerprint = JSON.stringify(output);
                if (fingerprint === previous?.fingerprint) return previous?.outcome;
                if (!previous && fingerprint === this.initialFingerprint)
                    return undefined;
                if (
                    !output.summary &&
                    output.artifacts.length === 0 &&
                    output.links.length === 0
                )
                    return undefined;
                const outcome = await store.commit(
                    {
                        version: 1,
                        id: OutcomeStore.createId(),
                        run_id: this.options.runId,
                        created_at: (this.options.now?.() ?? new Date()).toISOString(),
                        completeness: 'partial',
                        turn_index: turnIndex,
                        ...output,
                        changesets: [],
                        warnings: [],
                    },
                    'present'
                );
                const checkpoint = { fingerprint, outcome, published: false };
                this.checkpointResult = checkpoint;
                await this.options.onAvailable?.(outcome, 'present');
                checkpoint.published = true;
                return outcome;
            } finally {
                await store.close();
            }
        });
    }

    private enqueue<T>(operation: () => Promise<T>): Promise<T> {
        const next = this.queue.then(operation);
        this.queue = next.catch(() => undefined);
        return next;
    }

    cleanup(): Promise<void> {
        return this.output.cleanup();
    }

    private async collectOnce(
        runtime: PreparedRuntime | undefined,
        completeness: OutcomeCompleteness
    ): Promise<RunOutcome | undefined> {
        const store = new OutcomeStore(this.options.home);
        try {
            const collected = runtime?.collectOutcome
                ? await runtime.collectOutcome(store)
                : undefined;
            const fallback = collected ?? {
                application_state: 'present' as const,
                ...(await this.output.collect(store)),
                changesets: [],
                warnings: [],
            };
            const outcome: RunOutcome = {
                version: 1,
                id: OutcomeStore.createId(),
                run_id: this.options.runId,
                created_at: (this.options.now?.() ?? new Date()).toISOString(),
                completeness,
                ...(fallback.summary ? { summary: fallback.summary } : {}),
                changesets: fallback.changesets,
                artifacts: fallback.artifacts,
                links: fallback.links,
                warnings: fallback.warnings,
            };
            this.outcome = await store.commit(outcome, fallback.application_state);
            this.applicationState = fallback.application_state;
            await runtime?.finalizeOutcome?.();
            await this.publish();
            return this.outcome;
        } finally {
            await store.close();
        }
    }

    private async publish(): Promise<void> {
        const outcome = this.outcome;
        const state = this.applicationState;
        if (!outcome || !state) return;
        if (!this.publication) {
            this.publication = Promise.resolve()
                .then(() => this.options.onAvailable?.(outcome, state))
                .catch((error) => {
                    this.publication = undefined;
                    throw error;
                });
        }
        await this.publication;
    }
}
