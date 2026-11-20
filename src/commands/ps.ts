import { defineCommand } from 'citty';
import { CloudClient } from '../cloud/client.js';

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
        cloud: {
            type: 'boolean',
            description: 'List runs on the optional workbenches.dev hosted service',
            default: false,
        },
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
    async run({ args, data }) {
        const output = new CliPresenter();
        if (args.cloud) {
            const client = CloudClient.from(data);
            const rows: string[][] = [];
            // Unfinished runs, those waiting on input first, or every run with --all.
            for await (const run of client.list(
                args.all ? ['all'] : ['needs_input', 'active']
            )) {
                if (args.json) {
                    // Only a run waiting on input has requests worth replaying its events for.
                    const pending =
                        run.status === 'needs_input'
                            ? (await client.snapshot(run.id)).pending_requests
                            : [];
                    console.log(
                        JSON.stringify({
                            ...run,
                            state: run.status,
                            needs_input: run.status === 'needs_input',
                            pending_requests: pending,
                        })
                    );
                } else
                    rows.push([
                        run.status,
                        run.id,
                        run.session_id,
                        `${run.workbench.organization_slug}/${run.workbench.slug}@${run.version.version}`,
                        run.created_at,
                    ]);
            }
            if (!args.json)
                process.stdout.write(
                    rows.length
                        ? renderTable(
                              ['STATUS', 'RUN', 'SESSION', 'WORKBENCH', 'STARTED'],
                              rows
                          )
                        : 'No Workbench runs.\n'
                );
            return;
        }
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
                    const { task: _task, ...record } = run;
                    const snapshot = await services.supervision.snapshot(run);
                    process.stdout.write(
                        `${JSON.stringify({
                            ...record,
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
