import { defineCommand } from 'citty';
import { Connection } from '../database/connection.js';
import { workbenchHome } from '../storage.js';
import { Services } from '../workbench/services.js';
import { CliInput } from './input.js';
import { CliReceipt } from './receipt.js';

export const answerCommand = defineCommand({
    meta: {
        name: 'answer',
        description: 'Answer a pending permission or question.',
    },
    args: {
        session: {
            type: 'positional',
            required: true,
            description: 'Session or run ID',
        },
        request: {
            type: 'positional',
            required: true,
            description: 'Pending request ID reported by wait',
        },
        response: {
            type: 'positional',
            required: false,
            description:
                'allow, deny, an offered option, free text, or JSON string arrays',
        },
        'response-file': {
            type: 'string',
            description: 'Read a response from a UTF-8 file',
        },
        stdin: {
            type: 'boolean',
            description: 'Read a response from stdin',
            default: false,
        },
        reject: {
            type: 'boolean',
            description: 'Reject a pending question',
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
            if (
                args.reject &&
                (args.response !== undefined || args['response-file'] || args.stdin)
            )
                throw new Error('--reject cannot be combined with a response');
            const response = args.reject
                ? '--reject'
                : await new CliInput().read({
                      text: args.response,
                      file: args['response-file'],
                      stdin: args.stdin,
                  });
            const home = workbenchHome();
            const connection = Connection.open(home);
            try {
                return await new Services(home, connection).control.answer(
                    args.session,
                    args.request,
                    response
                );
            } finally {
                connection.close();
            }
        });
    },
});
