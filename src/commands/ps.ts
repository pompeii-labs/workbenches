import { defineCommand } from 'citty';

import { RunStore } from '../runs/index.js';
import { workbenchHome } from '../storage.js';
import { CliPresenter } from './presenter.js';

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
        const output = new CliPresenter();
        const runs = await new RunStore(workbenchHome()).list({
            detachedOnly: true,
            activeOnly: !args.all,
        });
        if (runs.length === 0) {
            if (!args.json) {
                output.message(
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
            const fields = [
                run.status,
                run.id,
                `${run.workbench}@${run.workbench_version}`,
                run.runner,
                String(run.pid ?? '-'),
                run.dispatched_at,
            ];
            output.record({
                machine: fields,
                title: run.id,
                details: [
                    run.status,
                    `${run.workbench}@${run.workbench_version}`,
                    run.runner,
                ],
                tone:
                    run.status === 'failed'
                        ? 'error'
                        : run.status === 'cancelled'
                          ? 'warning'
                          : run.status === 'completed'
                            ? 'success'
                            : 'info',
            });
        }
    },
});
