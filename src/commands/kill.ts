import { defineCommand } from 'citty';

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
        session: {
            type: 'positional',
            description: 'Active session ID to stop',
            required: true,
        },
    },
    async run({ args }) {
        const output = new CliPresenter();
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
