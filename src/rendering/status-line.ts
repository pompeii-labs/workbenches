import { basename } from 'node:path';

import type { RunStatus } from '../runs/status.js';
import { sanitizeTerminalText } from './terminal-text.js';

export interface StatusLineOptions {
    /** Wall clock in ms; the liveness glyph advances one frame per second. */
    now: number;
    /** Typical tool calls per todo for the step bar. */
    typicalStep: number;
    color: boolean;
}

/** Runs quiet this long without an open tool are flagged. */
export const QUIET_MS = 180_000;

// The filled quadrant walks while a tool runs; the square breathes while the
// model thinks or writes. Both stay square, so the glyph keeps its identity.
const WORKING = [...'◰◳◲◱'];
const THINKING = [...'□▢▣■▣▢'];
const SHADES = [208, 214, 215, 214];

/**
 * One status line for a run: liveness glyph, workbench, plan bar with the
 * current item, step bar, elapsed time, and cost. A run waiting on input or
 * finished renders as that instead. Agent-supplied text is sanitized: plan
 * items and tool titles must not drive the terminal.
 */
export function renderStatusLine(run: RunStatus, options: StatusLineOptions): string {
    const c = palette(options.color);
    const name = clean(run.workbench, 32);
    const cost = `$${run.cost_usd.toFixed(2)}`;
    const elapsed = duration(
        options.now - Date.parse(run.started_at ?? run.dispatched_at)
    );

    if (run.status === 'running' || run.status === 'dispatched') {
        if (run.pending_input) {
            const what = clean(run.pending_input.action ?? run.pending_input.kind, 32);
            return `${c.orange(c.bold(`▲ ${name} needs input`))}${c.orange(` · ${what} · wb answer ${run.run_id}`)}`;
        }
        const tooling = run.activity.kind === 'tool';
        const frames = tooling ? WORKING : THINKING;
        const frame = Math.floor(options.now / 1000);
        const glyph = c.shade(SHADES[frame % SHADES.length] ?? 208)(
            frames[frame % frames.length] ?? '▣'
        );
        const quietMs =
            options.now -
            Date.parse(run.last_activity_at ?? run.started_at ?? run.dispatched_at);
        const quiet =
            !tooling && quietMs > QUIET_MS
                ? c.orange(` · quiet ${duration(quietMs)}`)
                : '';
        const progress =
            planBar(run, options.typicalStep, c) ?? c.dim(activity(run, options.now));
        return `${glyph} ${c.bold(name)} ${progress} ${c.dim(`· ${elapsed} ·`)} ${cost}${quiet}`;
    }

    const ago = duration(
        options.now - Date.parse(run.finished_at ?? run.dispatched_at)
    );
    if (run.status === 'completed') {
        return `${c.green('✓')} ${name} ${c.dim(`done ${ago} ago ·`)} ${cost}`;
    }
    return `${c.red('✕')} ${name} ${c.dim(`${run.status} ${ago} ago ·`)} ${cost}`;
}

/** ▰▰▰▱▱ 3/5 ▮▮▯▯▯▯ 7/16 · current item */
function planBar(run: RunStatus, typicalStep: number, c: Palette): string | undefined {
    const plan = run.plan;
    if (!plan || plan.total <= 0) return undefined;
    const cells = Math.min(plan.total, 10);
    const filled = Math.round((plan.completed / plan.total) * cells);
    const bar = `${c.orange('▰'.repeat(filled))}${c.dim('▱'.repeat(cells - filled))} ${plan.completed}/${plan.total}`;
    const step =
        run.steps.item === null ? '' : ` ${stepBar(run.steps.current, typicalStep, c)}`;
    const current = plan.items.find((item) => item.status === 'in_progress')?.text;
    return `${bar}${step}${current ? ` ${c.dim('·')} ${clean(current, 48)}` : ''}`;
}

/**
 * Tool calls on the current todo against a typical todo: the fast bar under
 * the plan's slow one. Past typical it fills orange and keeps counting, which
 * also exposes a todo list the agent stopped updating.
 */
function stepBar(current: number, typical: number, c: Palette): string {
    const cells = 6;
    if (current > typical)
        return c.orange(`${'▮'.repeat(cells)} ${current}/${typical}`);
    const filled = Math.round((current / typical) * cells);
    return `${'▮'.repeat(filled)}${c.dim(`${'▯'.repeat(cells - filled)} ${current}/${typical}`)}`;
}

function activity(run: RunStatus, now: number): string {
    const current = run.activity;
    switch (current.kind) {
        case 'tool':
            return `${clean(current.title, 40)} ${duration(now - Date.parse(current.started_at))}`;
        case 'file':
            return `${clean(current.operation, 12)} ${clean(basename(current.path), 32)}`;
        default:
            return current.kind;
    }
}

function clean(value: string, max: number): string {
    const text = sanitizeTerminalText(value).replace(/\s+/gu, ' ').trim();
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function duration(ms: number): string {
    const seconds = Math.max(0, Math.floor(ms / 1000));
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
    return `${Math.floor(seconds / 3600)}h${String(Math.floor((seconds % 3600) / 60)).padStart(2, '0')}m`;
}

type Style = (value: string) => string;
interface Palette {
    orange: Style;
    green: Style;
    red: Style;
    dim: Style;
    bold: Style;
    shade: (code: number) => Style;
}

function palette(color: boolean): Palette {
    const wrap =
        (open: string, close = '\u001b[0m'): Style =>
        (value) =>
            color ? `${open}${value}${close}` : value;
    return {
        orange: wrap('\u001b[38;5;208m'),
        green: wrap('\u001b[32m'),
        red: wrap('\u001b[31m'),
        dim: wrap('\u001b[2m', '\u001b[22m'),
        bold: wrap('\u001b[1m', '\u001b[22m'),
        shade: (code) => wrap(`\u001b[38;5;${code}m`),
    };
}
