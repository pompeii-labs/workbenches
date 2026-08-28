import { defineCommand } from 'citty';

import { RunStore } from '../runs/index.js';
import { workbenchHome } from '../storage.js';

export const psCommand = defineCommand({
    meta: {
        name: 'ps',
        description: 'List detached Workbench runs.',
    },
    args: {
        all: {
            type: 'boolean',
            alias: 'a',
            description: 'Include finished detached runs',
            default: false,
        },
        json: {
            type: 'boolean',
            description: 'Emit one run record per NDJSON line',
            default: false,
        },
    },
    async run({ args }) {
        const runs = await new RunStore(workbenchHome()).list({
            detachedOnly: true,
            activeOnly: !args.all,
        });
        if (runs.length === 0) {
            if (!args.json) {
                console.log(
                    args.all ? 'No detached runs.' : 'No active detached runs.'
                );
            }
            return;
        }
        for (const run of runs) {
            if (args.json) {
                process.stdout.write(`${JSON.stringify(run)}\n`);
                continue;
            }
            console.log(
                [
                    run.status,
                    run.id,
                    `${run.workbench}@${run.workbench_version}`,
                    run.runner,
                    run.pid ?? '-',
                    run.dispatched_at,
                ].join('\t')
            );
        }
    },
});
