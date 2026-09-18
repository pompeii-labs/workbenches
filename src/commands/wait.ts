import { defineCommand } from 'citty';
import { type RunSnapshot, RunSupervision } from '../runs/supervision.js';
import { SessionLifecycle } from '../sessions/lifecycle.js';
import { workbenchHome } from '../storage.js';

export const waitCommand = defineCommand({
    meta: {
        name: 'wait',
        description:
            'Wait read-only for a turn boundary, terminal execution, or input request.',
    },
    args: {
        session: {
            type: 'positional',
            required: true,
            description: 'Session or run ID',
        },
        json: {
            type: 'boolean',
            description: 'Print one JSON result, never an event stream',
            default: false,
        },
        timeout: {
            type: 'string',
            description: 'Maximum seconds to wait; expiry leaves the session unchanged',
        },
        after: {
            type: 'string',
            description: 'Wait past an event sequence returned by send or wait',
        },
    },
    async run({ args }) {
        const home = workbenchHome();
        const activity = await new SessionLifecycle(home).resolve(args.session);
        const abort = new AbortController();
        const stop = () => abort.abort();
        process.on('SIGINT', stop);
        try {
            const result = await new RunSupervision(home).wait(activity.run, {
                ...(args.after !== undefined
                    ? { afterSequence: Number(args.after) }
                    : {}),
                ...(args.timeout !== undefined
                    ? { timeoutMilliseconds: Number(args.timeout) * 1000 }
                    : {}),
                signal: abort.signal,
            });
            process.stdout.write(
                args.json ? `${JSON.stringify(result)}\n` : summary(result)
            );
            process.exitCode = result.interrupted
                ? 130
                : result.state === 'failed'
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
    },
});

function summary(result: RunSnapshot): string {
    const pending = result.pending_requests.map(
        (request) =>
            `${request.kind} · ${request.id}: ${JSON.stringify(request.details)}`
    );
    const answer = result.final.replace(/\s+/g, ' ').slice(0, 1000);
    return `${[
        `${result.state} · ${result.session_id} · sequence ${result.sequence}`,
        answer,
        result.error,
        result.outcome_id ? `Outcome: ${result.outcome_id}` : undefined,
        ...pending.slice(0, 4),
    ]
        .filter(Boolean)
        .join('\n')}\n`;
}
