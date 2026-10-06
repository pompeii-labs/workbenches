import { basename } from 'node:path';

import { defineCommand } from 'citty';

import { renderStatusLine } from '../rendering/status-line.js';
import { sanitizeTerminalText } from '../rendering/terminal-text.js';
import { median, type RunStatus, RunStatusReader } from '../runs/status.js';
import { workbenchHome } from '../storage.js';

/** Finished runs stay visible this long. */
const RECENT_MS = 10 * 60_000;
/** Tool calls per todo when neither the run nor the workbench has history. */
const DEFAULT_STEP = 15;

export const statusCommand = defineCommand({
    meta: {
        name: 'status',
        description: 'Show live progress for active and recently finished runs.',
    },
    args: {
        line: {
            type: 'boolean',
            description:
                'Print one line for a status bar (Claude Code statusLine, tmux, and similar)',
            default: false,
        },
        json: {
            type: 'boolean',
            description: 'Print the run summaries as JSON',
            default: false,
        },
    },
    async run({ args }) {
        const reader = new RunStatusReader(workbenchHome());
        const now = Date.now();
        const runs = rank(await reader.list({ recentMs: RECENT_MS, now }));
        if (args.json) {
            process.stdout.write(`${JSON.stringify(runs)}\n`);
            return;
        }
        const color =
            !process.env.NO_COLOR && (args.line || process.stdout.isTTY === true);
        const line = async (run: RunStatus) =>
            renderStatusLine(run, {
                now,
                color,
                typicalStep: await typicalStep(reader, run),
            });

        if (args.line) {
            const [first] = runs;
            if (!first) {
                process.stdout.write(`${idle(await statusLineSession(), color)}\n`);
                return;
            }
            const more = runs.slice(1).filter(active).length;
            const suffix = more ? ` ${dim(`+${more} more`, color)}` : '';
            process.stdout.write(`${await line(first)}${suffix}\n`);
            return;
        }
        if (runs.length === 0) {
            process.stdout.write('No active or recent Workbench runs.\n');
            return;
        }
        for (const run of runs)
            process.stdout.write(`${await line(run)}  ${dim(run.run_id, color)}\n`);
    },
});

/** Runs waiting on input first, then running, then finished; newest first within each. */
function rank(runs: RunStatus[]): RunStatus[] {
    const weight = (run: RunStatus) => (active(run) ? (run.pending_input ? 0 : 1) : 2);
    return runs.toSorted(
        (left, right) =>
            weight(left) - weight(right) ||
            (right.started_at ?? right.dispatched_at).localeCompare(
                left.started_at ?? left.dispatched_at
            )
    );
}

function active(run: RunStatus): boolean {
    return run.status === 'running' || run.status === 'dispatched';
}

/** This run's median once three todos finished, else the workbench's history. */
async function typicalStep(reader: RunStatusReader, run: RunStatus): Promise<number> {
    if (run.steps.completed.length >= 3)
        return median(run.steps.completed) ?? DEFAULT_STEP;
    return (await reader.typicalStep(run.workbench, run.run_id)) ?? DEFAULT_STEP;
}

/**
 * Claude Code pipes session JSON to its status line command. With no runs to
 * show, its model and directory keep the line useful. Any other caller gets
 * a plain idle line; a stdin that never closes is abandoned after 100 ms.
 */
async function statusLineSession(): Promise<{ model?: string; directory?: string }> {
    if (process.stdin.isTTY) return {};
    const text = await Promise.race([
        new Response(Bun.stdin.stream()).text().catch(() => ''),
        new Promise<string>((resolve) => setTimeout(() => resolve(''), 100).unref()),
    ]);
    try {
        const session = JSON.parse(text) as {
            model?: { display_name?: unknown };
            workspace?: { current_dir?: unknown };
        };
        const model = session.model?.display_name;
        const directory = session.workspace?.current_dir;
        return {
            ...(typeof model === 'string' ? { model } : {}),
            ...(typeof directory === 'string'
                ? { directory: basename(directory) }
                : {}),
        };
    } catch {
        return {};
    }
}

function idle(session: { model?: string; directory?: string }, color: boolean): string {
    const text = [session.model, session.directory, 'no active runs']
        .filter((part): part is string => Boolean(part))
        .map((part) => sanitizeTerminalText(part).replace(/\s+/gu, ' ').slice(0, 40))
        .join(' · ');
    return dim(text, color);
}

function dim(value: string, color: boolean): string {
    return color ? `\u001b[2m${value}\u001b[22m` : value;
}
