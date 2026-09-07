import { defineCommand } from 'citty';

import { RunStore } from '../runs/index.js';
import { DockerManagedContainers } from '../runtimes/index.js';
import {
    SessionRetention,
    type SessionRetentionResult,
    type SessionRetentionReview,
} from '../sessions/index.js';
import { workbenchHome } from '../storage.js';
import { CliPresenter } from './presenter.js';

export const cleanCommand = defineCommand({
    meta: {
        name: 'clean',
        description: 'Preview or remove old Workbench run data.',
    },
    args: {
        'older-than': {
            type: 'string',
            valueHint: 'duration',
            description: 'Select terminal history older than this duration',
            default: '30d',
        },
        'include-sessions': {
            type: 'boolean',
            description: 'Also select native resumable session context',
            default: false,
        },
        apply: {
            type: 'boolean',
            description: 'Remove the selected data',
            default: false,
        },
        json: {
            type: 'boolean',
            description: 'Emit a machine-readable cleanup report',
            default: false,
        },
    },
    async run({ args }) {
        const home = workbenchHome();
        const duration = parseDuration(args['older-than']);
        const policy = {
            before: new Date(Date.now() - duration),
            includeResumableSessions: args['include-sessions'],
        };
        const containers = await DockerManagedContainers.connect(RunStore.scope(home));
        const retention = new SessionRetention(home, {
            ...(containers ? { containers } : {}),
        });
        const report = args.apply
            ? await retention.apply(policy)
            : await retention.review(policy);
        if (args.json) {
            process.stdout.write(`${JSON.stringify(machineReport(report))}\n`);
            return;
        }
        renderReport(report, args.apply);
    },
});

function parseDuration(value: string): number {
    const match = /^(\d+)(ms|s|m|h|d|w)$/.exec(value.trim().toLowerCase());
    if (!match) {
        throw new Error('--older-than must be a duration such as 12h, 7d, or 4w');
    }
    const amount = Number(match[1]);
    const units: Record<string, number> = {
        ms: 1,
        s: 1_000,
        m: 60_000,
        h: 3_600_000,
        d: 86_400_000,
        w: 604_800_000,
    };
    const duration = amount * (units[match[2] ?? ''] ?? 0);
    if (!Number.isSafeInteger(duration)) {
        throw new Error('--older-than is too large');
    }
    return duration;
}

function renderReport(
    report: SessionRetentionReview | SessionRetentionResult,
    applied: boolean
): void {
    const output = new CliPresenter();
    const result = 'removedRuns' in report ? report : undefined;
    const sessions = result?.removedSessions.length ?? report.sessions.length;
    const runs = result?.removedRuns.length ?? report.runs.length;
    const containers = result?.removedContainers.length ?? report.containers.length;
    const bytes = result?.removedBytes ?? report.bytes;
    if (sessions + runs + containers === 0) {
        output.message('Nothing eligible for cleanup.');
    } else {
        output.record({
            machine: [
                applied ? 'removed' : 'preview',
                String(sessions),
                String(runs),
                String(containers),
                String(bytes),
            ],
            title: applied ? 'Cleanup complete' : 'Cleanup preview',
            details: [
                `${sessions} sessions`,
                `${runs} runs`,
                `${containers} containers`,
                formatBytes(bytes),
            ],
            tone: applied ? 'success' : 'info',
        });
    }
    if (!applied && report.sessions.length + report.runs.length > 0) {
        output.message('Run again with --apply to remove this data.');
    }
    if (report.protectedResumableSessions.length > 0) {
        output.message(
            `${report.protectedResumableSessions.length} resumable sessions protected. Use --include-sessions to select them.`
        );
    }
    if (result && result.skipped.length > 0) {
        output.message(
            `${result.skipped.length} items changed during cleanup and were left in place.`,
            'warning'
        );
    }
}

function machineReport(
    report: SessionRetentionReview | SessionRetentionResult
): Record<string, unknown> {
    const result = 'removedRuns' in report ? report : undefined;
    return {
        version: 1,
        mode: result ? 'apply' : 'preview',
        policy: {
            before: report.before,
            include_resumable_sessions: report.includeResumableSessions,
        },
        eligible: {
            sessions: report.sessions,
            runs: report.runs,
            containers: report.containers.map((container) => ({
                id: container.id,
                name: container.name,
                run_id: container.runId,
            })),
            bytes: report.bytes,
        },
        protected: {
            active_runs: report.activeRuns,
            resumable_sessions: report.protectedResumableSessions,
        },
        reconciled_runs: report.reconciledRuns,
        ...(result
            ? {
                  removed: {
                      sessions: result.removedSessions,
                      runs: result.removedRuns,
                      containers: result.removedContainers,
                      bytes: result.removedBytes,
                  },
                  skipped: result.skipped,
              }
            : {}),
    };
}

function formatBytes(bytes: number): string {
    if (bytes < 1_024) return `${bytes} B`;
    const units = ['KiB', 'MiB', 'GiB', 'TiB'];
    let value = bytes;
    let unit = 'B';
    for (const next of units) {
        value /= 1_024;
        unit = next;
        if (value < 1_024) break;
    }
    return `${value.toFixed(value < 10 ? 1 : 0)} ${unit}`;
}
