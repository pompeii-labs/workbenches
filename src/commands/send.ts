import { defineCommand } from 'citty';
import { SessionControl } from '../sessions/control.js';
import { workbenchHome } from '../storage.js';
import { CliInput } from './input.js';
import { CliReceipt } from './receipt.js';

export const sendCommand = defineCommand({
    meta: {
        name: 'send',
        description:
            'Send work to an idle session, steer an active turn, or queue a follow-up.',
    },
    args: {
        session: {
            type: 'positional',
            required: true,
            description: 'Session or run ID',
        },
        text: { type: 'positional', required: false, description: 'Input text' },
        'task-file': { type: 'string', description: 'Read input from a UTF-8 file' },
        stdin: {
            type: 'boolean',
            description: 'Read input from stdin',
            default: false,
        },
        steer: {
            type: 'boolean',
            description: 'Steer only an active turn',
            default: false,
        },
        queue: {
            type: 'boolean',
            description: 'Queue a follow-up at the next turn boundary',
            default: false,
        },
        json: {
            type: 'boolean',
            description: 'Print one JSON receipt',
            default: false,
        },
    },
    async run({ args }) {
        await new CliReceipt().execute(args.json, async () => {
            if (args.steer && args.queue)
                throw new Error('--steer and --queue cannot be used together');
            const input = await new CliInput().read({
                text: args.text,
                file: args['task-file'],
                stdin: args.stdin,
            });
            return new SessionControl(workbenchHome()).send(
                args.session,
                input,
                args.steer ? 'steer' : args.queue ? 'queue' : 'send'
            );
        });
    },
});
