import { defineCommand } from 'citty';
import { SessionSupervision } from '../sessions/supervision.js';
import { workbenchHome } from '../storage.js';
import { CliWait } from './waiting.js';

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
            description: 'One or more session or run IDs',
        },
        run: {
            type: 'boolean',
            description:
                "Treat the ID as an exact run, including a session's first run",
            default: false,
        },
        first: {
            type: 'boolean',
            description:
                'With multiple IDs, return when the first run reaches a boundary',
            default: false,
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
            description:
                'Wait past a sequence, or comma-separated sequences matching multiple IDs',
        },
    },
    async run({ args }) {
        const ids = args._;
        if (new Set(ids).size !== ids.length)
            throw new Error('Each ID may be waited on only once');
        const afterSequences = parseAfter(args.after, ids.length);
        const home = workbenchHome();
        const supervision = new SessionSupervision(home);
        const runs = await Promise.all(
            ids.map((id) => supervision.resolve(id, { exactRun: args.run }))
        );
        if (new Set(runs.map((run) => run.id)).size !== runs.length)
            throw new Error('Each resolved run may be waited on only once');
        await new CliWait().execute(home, runs, {
            json: args.json,
            first: args.first,
            ...(afterSequences ? { afterSequences } : {}),
            ...(args.timeout !== undefined
                ? { timeoutMilliseconds: Number(args.timeout) * 1000 }
                : {}),
        });
    },
});

function parseAfter(after: string | undefined, count: number): number[] | undefined {
    if (after === undefined) return undefined;
    const parts = after.split(',');
    if (parts.some((part) => part.trim() === ''))
        throw new Error('--after must be a non-negative integer');
    const values = parts.map((value) => Number(value));
    if (values.length !== 1 && values.length !== count)
        throw new Error('--after must provide one sequence or one sequence per run');
    if (values.some((value) => !Number.isSafeInteger(value) || value < 0))
        throw new Error('--after must be a non-negative integer');
    return values.length === 1 ? Array(count).fill(values[0] ?? 0) : values;
}
