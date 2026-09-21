import { defineCommand } from 'citty';

import { createEventRenderer } from '../rendering/index.js';
import { RepositoryDeliveryStore } from '../repositories/receipts.js';
import { RunStore } from '../runs/index.js';
import { SessionLifecycle } from '../sessions/index.js';
import { workbenchHome } from '../storage.js';

export const attachCommand = defineCommand({
    meta: {
        name: 'attach',
        description: 'Observe or replay a Workbench session.',
    },
    args: {
        session: {
            type: 'positional',
            description: 'Session ID (defaults to the latest session)',
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
        const store = new RunStore(home);
        const lifecycle = new SessionLifecycle(home);
        const activity = args.session
            ? await lifecycle.resolve(args.session)
            : await lifecycle.latest();
        const initial = activity.run;
        const renderer = createEventRenderer({
            mode: args.json ? 'json' : args.final ? 'final' : 'human',
            ...(args.color === undefined ? {} : { color: args.color }),
        });
        try {
            for await (const event of store.follow(initial.id)) {
                renderer.render(event);
            }
        } finally {
            renderer.finish();
        }
        const completed = await store.read(initial.id);
        if (completed.status === 'failed') process.exitCode = completed.exit_code ?? 1;
        if (completed.status === 'cancelled') process.exitCode = 130;
        if (
            (await new RepositoryDeliveryStore(home).read(completed.id))?.state ===
            'failed'
        )
            process.exitCode = 1;
    },
});
