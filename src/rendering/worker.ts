import type { WorkerStatus } from '../workers/controller.js';
import type { WorkerSettings, WorkerStopMode } from '../workers/home.js';
import { clock, duration } from '../workers/log.js';
import { sanitizeTerminalText } from './terminal-text.js';

const FOLLOW = 'Follow it with: wb worker logs -f';

/** What `wb worker start` prints once the service is running. */
export function workerStartedLine(
    worker: { name: string; organization: string },
    settings: WorkerSettings,
    online: boolean
): string {
    const offered = `${slots(settings.slots)}, runtimes ${settings.runtimes.join(', ')}.`;
    const state = online
        ? `is online for ${worker.organization}.`
        : `started for ${worker.organization} and is still connecting.`;
    return `Worker ${worker.name} ${state} ${offered} ${FOLLOW}`;
}

/** What `wb worker stop` and `remove` print while the daemon still has runs. */
export function workerWaitingLine(
    name: string,
    runs: number,
    mode: WorkerStopMode
): string {
    const counted = `${runs} ${runs === 1 ? 'run' : 'runs'}`;
    if (mode === 'now') return `Worker ${name} is cancelling ${counted}.`;
    const them = runs === 1 ? 'it' : 'them';
    return `Worker ${name} has ${counted} going. Waiting for ${them} to finish, or pass --now to stop ${them}.`;
}

/** `wb worker status`: a header line, then one line per active run. */
export function workerStatusLines(status: WorkerStatus, now: Date): string[] {
    if (!status.registered || !status.name)
        return [
            'This machine is not registered as a worker. Register and start it with: wb worker start --name <name>',
        ];
    const since = status.since ? new Date(status.since) : undefined;
    const header = [
        `Worker ${status.name} is ${status.online ? 'online' : 'offline'}`,
        status.organization ? ` for ${status.organization}` : '',
        since && !Number.isNaN(since.getTime())
            ? ` since ${moment(since, now)} (${duration(now.getTime() - since.getTime())})`
            : '',
        '.',
        status.running
            ? ` ${status.runs.length} of ${slots(status.slots ?? 0)} busy, runtimes ${(status.runtimes ?? []).join(', ')}.`
            : '',
        status.stopping === 'drain' ? ' Stopping after its runs finish.' : '',
        status.stopping === 'now' ? ' Stopping now.' : '',
    ].join('');
    const lines = [header];
    if (status.stopped)
        lines.push(
            sanitizeTerminalText(
                status.stopped.charAt(0).toUpperCase() + status.stopped.slice(1)
            )
        );
    for (const run of status.runs) {
        lines.push(
            [
                '',
                sanitizeTerminalText(run.workbench),
                sanitizeTerminalText(run.run_id),
                run.runtime,
                duration(now.getTime() - Date.parse(run.started_at)),
                ...(run.state === 'running'
                    ? []
                    : [sanitizeTerminalText(run.state.replace(/_/g, ' '))]),
            ].join('  ')
        );
    }
    return lines;
}

function slots(count: number): string {
    return `${count} ${count === 1 ? 'slot' : 'slots'}`;
}

/** Local `HH:MM:SS` today, with the date before it on any other day. */
function moment(at: Date, now: Date): string {
    if (at.toDateString() === now.toDateString()) return clock(at);
    const date = [
        at.getFullYear(),
        String(at.getMonth() + 1).padStart(2, '0'),
        String(at.getDate()).padStart(2, '0'),
    ].join('-');
    return `${date} ${clock(at)}`;
}
