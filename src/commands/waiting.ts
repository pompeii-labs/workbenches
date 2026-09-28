import type { StoredRun } from '../runs/store.js';
import { type SessionSnapshot, SessionSupervision } from '../sessions/supervision.js';

export interface WaitOptions {
    json: boolean;
    first?: boolean;
    afterSequences?: Array<number | undefined>;
    timeoutMilliseconds?: number;
}

export class CliWait {
    async execute(
        home: string,
        runs: StoredRun | StoredRun[],
        options: WaitOptions
    ): Promise<void> {
        const selected = Array.isArray(runs) ? runs : [runs];
        const abort = new AbortController();
        const stop = () => abort.abort();
        process.on('SIGINT', stop);
        try {
            const snapshots = await this.wait(home, selected, options, abort);
            if (selected.length === 1) {
                const [result] = snapshots;
                if (!result) throw new Error('Wait did not produce a result');
                process.stdout.write(
                    options.json ? `${JSON.stringify(result)}\n` : summary(result)
                );
                process.exitCode = exitCode(result);
                return;
            }
            const result = {
                mode: options.first ? 'first' : 'all',
                results: snapshots,
                ...(options.first
                    ? {
                          remaining_run_ids: selected
                              .filter((run) => run.id !== snapshots[0]?.run_id)
                              .map((run) => run.id),
                      }
                    : {}),
            };
            process.stdout.write(
                options.json
                    ? `${JSON.stringify(result)}\n`
                    : `${snapshots.map(summary).join('')}`
            );
            process.exitCode = aggregateExitCode(snapshots);
        } finally {
            process.off('SIGINT', stop);
        }
    }

    private async wait(
        home: string,
        runs: StoredRun[],
        options: WaitOptions,
        abort: AbortController
    ): Promise<SessionSnapshot[]> {
        const supervision = new SessionSupervision(home);
        const wait = (run: StoredRun, index: number) =>
            supervision.wait(run, {
                ...(options.afterSequences?.[index] !== undefined
                    ? { afterSequence: options.afterSequences[index] }
                    : {}),
                ...(options.timeoutMilliseconds !== undefined
                    ? { timeoutMilliseconds: options.timeoutMilliseconds }
                    : {}),
                signal: abort.signal,
            });
        const waiting = runs.map(wait);
        if (!options.first) return Promise.all(waiting);
        const first = await Promise.race(waiting);
        // Stop the other read-only observers before returning the first boundary.
        if (!abort.signal.aborted) abort.abort();
        return [first];
    }
}

function exitCode(result: SessionSnapshot): number {
    return result.interrupted
        ? 130
        : result.state === 'failed' || result.delivery?.state === 'failed'
          ? 1
          : result.state === 'cancelled'
            ? 130
            : result.state === 'needs_input'
              ? 2
              : result.state === 'timeout'
                ? 124
                : 0;
}

function aggregateExitCode(results: SessionSnapshot[]): number {
    const codes = results.map(exitCode);
    if (codes.includes(1)) return 1;
    if (codes.includes(130)) return 130;
    if (codes.includes(2)) return 2;
    if (codes.includes(124)) return 124;
    return 0;
}

function summary(result: SessionSnapshot): string {
    const pending = result.pending_requests.map(
        (request) =>
            `${request.kind} · ${request.id}: ${JSON.stringify(request.details)}`
    );
    const answer = result.final.replace(/\s+/g, ' ').slice(0, 1000);
    return `${[`${result.state} · ${result.session_id} · sequence ${result.sequence}`, answer, result.error, result.outcome_id ? `Outcome: ${result.outcome_id}` : undefined, result.delivery?.pull_request?.url, result.delivery?.state === 'failed' ? `PR delivery failed: ${result.delivery.message}` : undefined, result.authoring?.result?.packages.map((entry) => entry.path).join(', '), ...(result.authoring?.result?.warnings ?? []), ...pending.slice(0, 4)].filter(Boolean).join('\n')}\n`;
}
