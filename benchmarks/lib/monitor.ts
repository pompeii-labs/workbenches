import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseEvents } from './metrics.ts';
import { type Arm, identifier, modelSlug, trialName } from './spec.ts';

const terminal = new Set(['passed', 'failed', 'inconclusive', 'infra_error']);
const tools = new Set([
    'bash',
    'read',
    'write',
    'edit',
    'apply_patch',
    'glob',
    'grep',
    'skill',
    'task',
    'webfetch',
    'websearch',
    'todowrite',
    'todoread',
    'question',
]);
const numeric = (n: unknown): number | null =>
    typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null;
function json(path: string) {
    try {
        return JSON.parse(readFileSync(path, 'utf8'));
    } catch {
        return null;
    }
}
function meter(value: any) {
    return {
        tokens: numeric(value?.tokens?.total),
        cost_usd: numeric(value?.cost_usd),
    };
}
function stream(path: string) {
    if (!existsSync(path)) return null;
    const text = readFileSync(path, 'utf8');
    const events = text.split('\n').flatMap((line) => {
        try {
            return [JSON.parse(line)];
        } catch {
            return [];
        }
    });
    const normalized = events.some(
        (e) => e.protocol !== undefined || e.type === 'run.started'
    );
    const metrics = parseEvents(path, normalized ? 'workbench' : 'plain');
    let activity = 'starting';
    for (const e of events) {
        if (e.type === 'input.requested') activity = 'input requested';
        else if (e.type === 'tool.started' || e.type === 'tool_use') {
            const name = e.data?.name ?? e.part?.tool;
            activity = `tool: ${tools.has(name) ? name : 'other'}`;
        } else if (e.type === 'output.text' || e.type === 'text')
            activity = 'responding';
        else if (e.type === 'run.completed') activity = 'completed';
        else if (e.type === 'run.failed' || e.type === 'error')
            activity = 'runner error';
        else if (e.type === 'run.cancelled') activity = 'cancelled';
    }
    return {
        ...meter(metrics),
        completed: metrics.completed,
        activity,
        updated: statSync(path).mtimeMs,
    };
}

export function campaignSnapshot(directory: string, now = Date.now()) {
    const plan = json(join(directory, 'campaign.json'));
    if (
        !plan ||
        plan.version !== 1 ||
        !Array.isArray(plan.tasks) ||
        !Array.isArray(plan.arms) ||
        !Array.isArray(plan.models) ||
        !Number.isSafeInteger(plan.reps) ||
        plan.reps < 1
    )
        throw new Error('Missing or invalid campaign.json');
    const rows = [];
    for (const task of plan.tasks) {
        identifier(task.id, 'campaign task');
        for (const model of plan.models as string[])
            for (const arm of plan.arms as Arm[]) {
                if (!['plain', 'workbench'].includes(arm))
                    throw new Error('Invalid campaign arm');
                for (let rep = 1; rep <= plan.reps; rep++) {
                    const dir = join(
                        directory,
                        'trials',
                        trialName(task.id, model, arm, rep)
                    );
                    const resultPath = join(dir, 'result.json');
                    const result = json(resultPath);
                    const done = result?.version === 1 && terminal.has(result.status);
                    const actor = stream(join(dir, 'events.ndjson'));
                    const grader = stream(join(dir, 'grading', 'events.ndjson'));
                    const phase = done
                        ? result.status
                        : existsSync(resultPath)
                          ? 'result unreadable'
                          : grader
                            ? grader.completed
                                ? 'finalizing'
                                : 'grading'
                            : existsSync(join(dir, 'grading'))
                              ? 'preparing grade'
                              : actor
                                ? actor.completed
                                    ? 'preparing grade'
                                    : 'actor'
                                : existsSync(dir)
                                  ? 'preparing actor'
                                  : 'queued';
                    const latest = grader ?? actor;
                    rows.push({
                        task: task.id as string,
                        model: modelSlug(model),
                        arm,
                        rep,
                        phase: phase as string,
                        terminal: Boolean(done),
                        activity: done ? '-' : (latest?.activity ?? '-'),
                        assessments:
                            done && Array.isArray(result.verdicts)
                                ? result.verdicts
                                      .filter(
                                          (v: any) =>
                                              typeof v.id === 'string' &&
                                              /^[a-z0-9][a-z0-9-]*$/.test(v.id) &&
                                              ['pass', 'fail', 'not-tested'].includes(
                                                  v.status
                                              )
                                      )
                                      .map((v: any) => ({
                                          id: v.id as string,
                                          status: v.status as string,
                                      }))
                                : [],
                        seconds_since_event: latest
                            ? Math.max(0, Math.floor((now - latest.updated) / 1000))
                            : null,
                        actor: done
                            ? meter(result.metrics)
                            : meter(
                                  actor
                                      ? {
                                            tokens: { total: actor.tokens },
                                            cost_usd: actor.cost_usd,
                                        }
                                      : null
                              ),
                        grader: done
                            ? meter(result.grading_metrics)
                            : meter(
                                  grader
                                      ? {
                                            tokens: { total: grader.tokens },
                                            cost_usd: grader.cost_usd,
                                        }
                                      : null
                              ),
                    });
                }
            }
    }
    return { complete: rows.length > 0 && rows.every((r) => r.terminal), rows };
}

export function renderMonitor(
    snapshot: ReturnType<typeof campaignSnapshot>,
    options: { columns?: number; color?: boolean } = {}
): string {
    const width = Math.max(
        20,
        Math.min(100, (options.columns ?? process.stdout.columns ?? 100) - 2)
    );
    const color =
        options.color ??
        (Boolean(process.stdout.isTTY) && process.env.NO_COLOR === undefined);
    const lines: string[] = [];
    const paint = (text: string, code: number) =>
        color ? `\x1b[${code}m${text}\x1b[0m` : text;
    const line = (text = '', code?: number) => {
        // Wrap deliberately instead of letting long rows collide with the terminal edge.
        do {
            let end = Math.min(width, text.length);
            if (end < text.length) {
                const space = text.lastIndexOf(' ', end);
                if (space > 0) end = space;
            }
            const part = text.slice(0, end);
            lines.push(code === undefined ? part : paint(part, code));
            text = text.slice(end).trimStart();
        } while (text.length);
    };
    const age = (seconds: number) =>
        seconds < 60
            ? `${seconds}s`
            : seconds < 3600
              ? `${Math.floor(seconds / 60)}m ${seconds % 60}s`
              : `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
    const usage = (
        label: string,
        value: { tokens: number | null; cost_usd: number | null }
    ) => {
        const tokens =
            value.tokens === null ? '--' : value.tokens.toLocaleString('en-US');
        const cost = value.cost_usd === null ? '--' : `$${value.cost_usd.toFixed(4)}`;
        line(`  ${label.padEnd(7)} ${tokens.padStart(10)} tokens   ${cost}`);
    };
    line('WORKBENCHMARK', 1);
    line(
        `${snapshot.rows.filter((r) => r.terminal).length}/${snapshot.rows.length} finished  |  ${snapshot.complete ? 'COMPLETE' : 'WATCHING'}  |  read-only`,
        90
    );
    line('-'.repeat(width), 90);
    for (const task of new Set(snapshot.rows.map((r) => r.task))) {
        line(task, 1);
        for (const r of snapshot.rows.filter((r) => r.task === task)) {
            const waiting = !r.terminal && r.activity === 'input requested';
            const status = waiting ? 'WAITING FOR INPUT' : r.phase.toUpperCase();
            line(
                `  ${r.model}  ${r.arm.toUpperCase()}  #${r.rep}  ${status}`,
                waiting
                    ? 33
                    : r.phase === 'passed'
                      ? 32
                      : ['failed', 'infra_error'].includes(r.phase)
                        ? 31
                        : 36
            );
            usage('Actor', r.actor);
            usage('Grader', r.grader);
            for (const assessment of r.assessments ?? [])
                line(
                    `  ${assessment.status.toUpperCase().padEnd(10)} ${assessment.id}`,
                    assessment.status === 'pass'
                        ? 32
                        : assessment.status === 'fail'
                          ? 31
                          : 33
                );
            if (!r.terminal && r.phase !== 'queued') {
                if (waiting) line('  Action needed: review the pending request.', 33);
                else if (r.activity !== '-') line(`  Activity: ${r.activity}`, 90);
                if (r.seconds_since_event !== null)
                    line(
                        `  Last event: ${age(r.seconds_since_event)} ago`,
                        waiting ? 33 : 90
                    );
            }
            line();
        }
    }
    line('-'.repeat(width), 90);
    line('Ctrl+C stops this monitor, not the campaign.', 90);
    line('Usage: reported so far. -- = not reported.', 90);
    if (!snapshot.complete)
        line('Phases come from saved events, not process liveness.', 90);
    return lines.join('\n');
}

export async function monitorCampaign(
    directory: string,
    options: { once?: boolean; json?: boolean; intervalMs?: number } = {}
) {
    const interval = options.intervalMs ?? 2000;
    if (!Number.isInteger(interval) || interval < 250)
        throw new Error('Monitor interval must be at least 250ms');
    let stopped = false;
    const stop = () => {
        stopped = true;
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    try {
        while (!stopped) {
            const snapshot = campaignSnapshot(directory);
            if (process.stdout.isTTY && !options.json && !options.once)
                process.stdout.write('\x1b[2J\x1b[H');
            console.log(
                options.json ? JSON.stringify(snapshot) : renderMonitor(snapshot)
            );
            if (options.once || snapshot.complete) break;
            await Bun.sleep(interval);
        }
    } finally {
        process.off('SIGINT', stop);
        process.off('SIGTERM', stop);
    }
}
