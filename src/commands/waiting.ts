import type { StoredRun } from '../runs/store.js';
import { type SessionSnapshot, SessionSupervision } from '../sessions/supervision.js';

export class CliWait {
    async execute(
        home: string,
        run: StoredRun,
        options: { json: boolean; afterSequence?: number; timeoutMilliseconds?: number }
    ): Promise<void> {
        const abort = new AbortController();
        const stop = () => abort.abort();
        process.on('SIGINT', stop);
        try {
            const result = await new SessionSupervision(home).wait(run, {
                ...options,
                signal: abort.signal,
            });
            process.stdout.write(
                options.json ? `${JSON.stringify(result)}\n` : summary(result)
            );
            process.exitCode = result.interrupted
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
        } finally {
            process.off('SIGINT', stop);
        }
    }
}

function summary(result: SessionSnapshot): string {
    const pending = result.pending_requests.map(
        (request) =>
            `${request.kind} · ${request.id}: ${JSON.stringify(request.details)}`
    );
    const answer = result.final.replace(/\s+/g, ' ').slice(0, 1000);
    return `${[`${result.state} · ${result.session_id} · sequence ${result.sequence}`, answer, result.error, result.outcome_id ? `Outcome: ${result.outcome_id}` : undefined, result.delivery?.pull_request?.url, result.delivery?.state === 'failed' ? `PR delivery failed: ${result.delivery.message}` : undefined, result.authoring?.result?.packages.map((entry) => entry.path).join(', '), ...pending.slice(0, 4)].filter(Boolean).join('\n')}\n`;
}
