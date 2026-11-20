import { defineCommand } from 'citty';
import { CloudClient } from '../cloud/client.js';

import { Connection } from '../database/connection.js';
import { workbenchHome } from '../storage.js';
import { Services } from '../workbench/services.js';
import { CliPresenter } from './presenter.js';

export const killCommand = defineCommand({
    meta: {
        name: 'kill',
        description: 'Stop the active run in a Workbench session.',
    },
    args: {
        cloud: {
            type: 'boolean',
            description: 'Cancel on the optional workbenches.dev hosted service',
            default: false,
        },
        session: {
            type: 'positional',
            description: 'Active session ID to stop',
            required: true,
        },
    },
    async run({ args, data }) {
        const output = new CliPresenter();
        if (args.cloud) {
            const result = await CloudClient.from(data).command(
                args.session,
                'cancel',
                {}
            );
            output.record({
                machine: ['cancellation_requested', result.session_id],
                title: 'Cancellation requested',
                details: [result.session_id],
                tone: 'warning',
            });
            return;
        }
        const home = workbenchHome();
        const connection = Connection.open(home);
        try {
            const services = new Services(home, connection);
            const activity = await services.lifecycle.resolve(args.session);
            output.progress(`Stopping ${activity.id}`);
            const result = await services.control.cancel(activity.id);
            output.record({
                machine: ['cancelled', result.session_id],
                title: 'Stopped session',
                details: [result.session_id],
                tone: 'warning',
            });
        } finally {
            connection.close();
        }
    },
});
