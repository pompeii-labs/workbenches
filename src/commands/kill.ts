import { defineCommand } from 'citty';

import {
    clearStoredRunCancellation,
    followRunEvents,
    latestActiveDetachedRun,
    readStoredRun,
    requestStoredRunCancellation,
} from '../run-store.js';
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
        const run = args.run
            ? await readStoredRun(home, args.run)
            : await latestActiveDetachedRun(home);
        await requestStoredRunCancellation(home, run.id);
        for await (const _event of followRunEvents(home, run.id)) {
            // The worker owns the event stream; kill only waits for its acknowledgement.
        }
        await clearStoredRunCancellation(home, run.id);
        const finished = await readStoredRun(home, run.id);
        if (finished.status !== 'cancelled') {
            throw new Error(
                `Workbench run finished as ${finished.status} before cancellation: ${run.id}`
            );
        }
        console.log(`cancelled\t${run.id}`);
    },
});
