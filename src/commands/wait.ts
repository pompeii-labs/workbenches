import { defineCommand } from 'citty';
import { CloudClient } from '../cloud/client.js';
import { Connection } from '../database/connection.js';
import { workbenchHome } from '../storage.js';
import { Services } from '../workbench/services.js';
import { CliWait } from './waiting.js';

export const waitCommand = defineCommand({
    meta: {
        name: 'wait',
        description:
            'Wait read-only for a turn boundary, terminal execution, or input request.',
    },
    args: {
        cloud: {
            type: 'boolean',
            description: 'Wait on the optional workbenches.dev hosted service',
            default: false,
        },
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
    async run({ args, data }) {
        if (args.cloud) {
            await new CliWait(CloudClient.from(data)).execute(args.session, {
                json: args.json,
                ...(args.after !== undefined
                    ? { afterSequence: Number(args.after) }
                    : {}),
                ...(args.timeout !== undefined
                    ? { timeoutMilliseconds: Number(args.timeout) * 1000 }
                    : {}),
            });
            return;
        }
        const home = workbenchHome();
        const connection = Connection.open(home);
        try {
            const supervision = new Services(home, connection).sessionSupervision;
            const run = await supervision.resolve(args.session, {
                exactRun: args.run,
            });
            await new CliWait(supervision).execute(run, {
                json: args.json,
                ...(args.after !== undefined
                    ? { afterSequence: Number(args.after) }
                    : {}),
                ...(args.timeout !== undefined
                    ? { timeoutMilliseconds: Number(args.timeout) * 1000 }
                    : {}),
            });
        } finally {
            connection.close();
        }
    },
});
