import { defineCommand } from 'citty';

import { RunDispatcher, RunStore } from '../runs/index.js';
import { workbenchHome } from '../storage.js';

export const killCommand = defineCommand({
    meta: {
        name: 'kill',
        description: 'Cancel a detached Workbench run.',
    },
    args: {
        run: {
            type: 'positional',
            description: 'Run ID (defaults to the latest active detached run)',
            required: false,
        },
    },
    async run({ args }) {
        const home = workbenchHome();
        const store = new RunStore(home);
        const run = args.run
            ? await store.read(args.run)
            : await store.latestActiveDetached();
        await new RunDispatcher(home).handle(run.id).cancel('requested');
        for await (const _event of store.follow(run.id)) {
            // The worker owns the event stream; kill only waits for its acknowledgement.
        }
        await store.clearCancellation(run.id);
        const finished = await store.read(run.id);
        if (finished.status !== 'cancelled') {
            throw new Error(
                `Workbench run finished as ${finished.status} before cancellation: ${run.id}`
            );
        }
        console.log(`cancelled\t${run.id}`);
    },
});
