import { defineCommand } from 'citty';

import { RunStore } from '../runs/index.js';
import {
    type SessionActivity,
    SessionIdentity,
    SessionLifecycle,
} from '../sessions/index.js';
import { workbenchHome } from '../storage.js';
import { CliPresenter } from './presenter.js';

export const psCommand = defineCommand({
    meta: {
        name: 'ps',
        description: 'List Workbench sessions.',
    },
    args: {
        all: {
            type: 'boolean',
            alias: 'a',
            description: 'Include terminal one-shot session history',
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
        const identity = new SessionIdentity();
        const activities = await new SessionLifecycle(workbenchHome()).list({
            all: args.all,
        });
        if (activities.length === 0) {
            if (!args.json) {
                output.message(
                    args.all
                        ? 'No Workbench sessions.'
                        : 'No active or resumable Workbench sessions.'
                );
            }
            return;
        }
        for (const activity of activities) {
            const run = activity.run;
            if (args.json) {
                process.stdout.write(
                    `${JSON.stringify({
                        ...run,
                        session_id: activity.id,
                        session_name: activity.session?.name,
                        resumable: activity.resumable,
                    })}\n`
                );
                continue;
            }
            const fields = [
                run.status,
                activity.id,
                `${run.workbench}@${run.workbench_version}`,
                run.runner,
                String(run.pid ?? '-'),
                run.dispatched_at,
                activity.session?.name,
            ];
            output.record({
                machine: fields,
                title: activity.session
                    ? identity.label(activity.session)
                    : activity.id,
                details: [
                    activity.session?.name ? activity.id : undefined,
                    run.status,
                    `${run.workbench}@${run.workbench_version}`,
                    run.runner,
                    action(activity),
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

function action(activity: SessionActivity): string {
    if (!RunStore.isTerminal(activity.run.status)) return 'attach';
    return activity.resumable ? 'resume' : 'replay';
}
