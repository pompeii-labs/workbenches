import { defineCommand } from 'citty';
import { SessionLifecycle } from '../sessions/lifecycle.js';
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
        await new CliWait().execute(home, activity.run, {
            json: args.json,
            ...(args.after !== undefined ? { afterSequence: Number(args.after) } : {}),
            ...(args.timeout !== undefined
                ? { timeoutMilliseconds: Number(args.timeout) * 1000 }
                : {}),
        });
    },
});
