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
            description: 'Session or run ID',
        },
        run: {
            type: 'boolean',
            description:
                "Treat the ID as an exact run, including a session's first run",
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
            description: 'Wait past an event sequence returned by send or wait',
        },
    },
    async run({ args }) {
        const home = workbenchHome();
        const run = await new SessionSupervision(home).resolve(args.session, {
            exactRun: args.run,
        });
        await new CliWait().execute(home, run, {
            json: args.json,
            ...(args.after !== undefined ? { afterSequence: Number(args.after) } : {}),
            ...(args.timeout !== undefined
                ? { timeoutMilliseconds: Number(args.timeout) * 1000 }
                : {}),
        });
    },
});
