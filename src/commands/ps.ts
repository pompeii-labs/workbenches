import { defineCommand } from 'citty';

import { Connection } from '../database/connection.js';
import { workbenchHome } from '../storage.js';
import { Services } from '../workbench/services.js';
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
        const home = workbenchHome();
        const connection = Connection.open(home);
        try {
            const services = new Services(home, connection);
            services.legacy.show();
            const activities = await services.lifecycle.list({
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
            if (!args.json) {
                const rows = activities.map((activity) => {
                    const run = activity.run;
                    return [
                        run.status,
                        activity.id,
                        `${run.workbench}@${run.workbench_version}`,
                        run.runner,
                        String(run.pid ?? '-'),
                        run.dispatched_at,
                        activity.session?.name ?? '-',
                    ];
                });
                process.stdout.write(
                    renderTable(
                        [
                            'STATUS',
                            'SESSION',
                            'WORKBENCH',
                            'RUNNER',
                            'PID',
                            'STARTED',
                            'NAME',
                        ],
                        rows
                    )
                );
                return;
            }
            for (const activity of activities) {
                const run = activity.run;
                if (args.json) {
                    const snapshot = await services.supervision.snapshot(run);
                    process.stdout.write(
                        `${JSON.stringify({
                            ...run,
                            session_id: activity.id,
                            session_name: activity.session?.name,
                            resumable: activity.resumable,
                            state: snapshot.state,
                            needs_input: snapshot.state === 'needs_input',
                            pending_requests: snapshot.pending_requests,
                        })}\n`
                    );
                }
            }
        } finally {
            connection.close();
        }
    },
});

function renderTable(headers: string[], rows: string[][]): string {
    const widths = headers.map((header, index) =>
        Math.max(header.length, ...rows.map((row) => row[index]?.length ?? 0))
    );
    const format = (row: string[]) =>
        row
            .map((value, index) => value.padEnd(widths[index] ?? value.length))
            .join('  ');
    return `${format(headers)}\n${rows.map(format).join('\n')}\n`;
}
