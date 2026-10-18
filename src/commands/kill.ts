import { defineCommand } from 'citty';

import { Connection } from '../database/connection.js';
import { RunStore } from '../runs/index.js';
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
            const store = services.runs;
            const activity = await services.lifecycle.resolve(args.session);
            if (RunStore.isTerminal(activity.run.status)) {
                throw new Error(
                    `Workbench session is already ${activity.run.status}: ${activity.id}`
                );
            }
            output.progress(`Stopping ${activity.id}`);
            await services.dispatcher.handle(activity.run.id).cancel('requested');
            for await (const _event of store.follow(activity.run.id)) {
                // The worker owns the event stream; kill only waits for its acknowledgement.
            }
            const finished = await store.read(activity.run.id);
            if (finished.status !== 'cancelled') {
                throw new Error(
                    `Workbench session finished as ${finished.status} before it stopped: ${activity.id}`
                );
            }
            output.record({
                machine: ['cancelled', activity.id],
                title: 'Stopped session',
                details: [activity.id],
                tone: 'warning',
            });
        } finally {
            connection.close();
        }
    },
});
