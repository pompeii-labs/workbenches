import { defineCommand } from 'citty';

import { createEventRenderer } from '../render.js';
import { followRunEvents, latestStoredRun, readStoredRun } from '../run-store.js';
import { workbenchHome } from '../storage.js';

export const attachCommand = defineCommand({
    meta: {
        name: 'attach',
        description: 'Replay and follow a dispatched Workbench run.',
    },
    args: {
        run: {
            type: 'positional',
            description: 'Run ID (defaults to the latest dispatched run)',
            required: false,
        },
        json: {
            type: 'boolean',
            description: 'Emit normalized Workbench NDJSON events',
            default: false,
        },
        final: {
            type: 'boolean',
            description: 'Print only the final assistant response',
            default: false,
        },
        color: {
            type: 'boolean',
            description: 'Force color in human-readable output',
            negativeDescription: 'Disable color in human-readable output',
        },
    },
    async run({ args }) {
        if (args.json && args.final) {
            throw new Error('--json and --final cannot be used together');
        }
        const home = workbenchHome();
        const initial = args.run
            ? await readStoredRun(home, args.run)
            : await latestStoredRun(home);
        const renderer = createEventRenderer({
            mode: args.json ? 'json' : args.final ? 'final' : 'human',
            ...(args.color === undefined ? {} : { color: args.color }),
        });
        try {
            for await (const event of followRunEvents(home, initial.id)) {
                renderer.render(event);
            }
        } finally {
            renderer.finish();
        }
        const completed = await readStoredRun(home, initial.id);
        if (completed.status === 'failed') process.exitCode = completed.exit_code ?? 1;
        if (completed.status === 'cancelled') process.exitCode = 130;
    },
});
