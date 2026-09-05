import { defineCommand } from 'citty';

import { RunDispatcher, RunStore } from '../runs/index.js';
import { SessionLifecycle } from '../sessions/index.js';
import { workbenchHome } from '../storage.js';
import { CliPresenter } from './presenter.js';

export const killCommand = defineCommand({
    meta: {
        name: 'kill',
        description: 'Stop the active run in a Workbench session.',
    },
    args: {
        session: {
            type: 'positional',
            description: 'Session ID (defaults to the latest active session)',
            required: false,
        },
    },
    async run({ args }) {
        const output = new CliPresenter();
        const home = workbenchHome();
        const store = new RunStore(home);
        const lifecycle = new SessionLifecycle(home);
        const activity = args.session
            ? await lifecycle.resolve(args.session)
            : await lifecycle.latestActive();
        if (RunStore.isTerminal(activity.run.status)) {
            throw new Error(
                `Workbench session is already ${activity.run.status}: ${activity.id}`
            );
        }
        output.progress(`Stopping ${activity.id}`);
        await new RunDispatcher(home).handle(activity.run.id).cancel('requested');
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
    },
});
