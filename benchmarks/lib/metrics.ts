import { readFileSync } from 'node:fs';
import type { Arm } from './spec.ts';

export interface Metrics {
    elapsed_ms: number;
    preparation_ms?: number;
    timing?: 'prepared' | 'cold';
    timed_out: boolean;
    exit_code: number | null;
    completed: boolean;
    cost_usd: number | null;
    tokens: {
        total: number | null;
        input: number | null;
        output: number | null;
        reasoning: number | null;
        cache_read: number | null;
        cache_write: number | null;
    };
    accounting_complete: boolean;
    steps: number;
    tool_calls: number;
}

type Tokens = Metrics['tokens'];

const num = (value: unknown) =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const add = (a: number | null, b: unknown) =>
    a === null || num(b) === null ? null : a + (b as number);
export function emptyMetrics(): Metrics {
    return {
        elapsed_ms: 0,
        timed_out: false,
        exit_code: null,
        completed: false,
        cost_usd: null,
        tokens: {
            total: null,
            input: null,
            output: null,
            reasoning: null,
            cache_read: null,
            cache_write: null,
        },
        accounting_complete: false,
        steps: 0,
        tool_calls: 0,
    };
}

/**
 * Both arms are measured from the same OpenCode stream. The plain arm writes
 * OpenCode's native `--format json` events; the workbench arm writes wb's
 * normalized events, which wb derives one-to-one from that same native stream.
 */
export function parseEvents(
    path: string,
    arm: Arm
): Omit<Metrics, 'elapsed_ms' | 'timed_out' | 'exit_code'> {
    const tokens: Tokens = {
        total: 0,
        input: 0,
        output: 0,
        reasoning: 0,
        cache_read: 0,
        cache_write: 0,
    };
    let cost: number | null = 0;
    let steps = 0;
    let completed = false;
    const tools = new Set<string>();
    const seen = new Set<string>();
    let errored = false;

    let text = '';
    try {
        text = readFileSync(path, 'utf8');
    } catch {}
    for (const line of text.split('\n')) {
        if (!line.startsWith('{')) continue;
        let event: any;
        try {
            event = JSON.parse(line);
        } catch {
            continue;
        }
        const identity =
            arm === 'plain'
                ? event.type === 'step_finish'
                    ? event.part?.id
                    : undefined
                : event.run_id && event.sequence !== undefined
                  ? `${event.run_id}:${event.sequence}`
                  : undefined;
        if (identity && seen.has(identity)) continue;
        if (identity) seen.add(identity);
        // An engine run.failed after the turn already completed (for example the
        // engine rejecting a declared outcome artifact) does not make the usage
        // accounting incomplete: every usage event was already recorded.
        const postTurnEngineFailure =
            arm !== 'plain' && event.type === 'run.failed' && completed;
        if (
            !postTurnEngineFailure &&
            (event.type === 'error' ||
                event.type === 'run.failed' ||
                event.type === 'run.cancelled')
        )
            errored = true;
        if (arm === 'plain') {
            if (event.type === 'step_finish') {
                const part = event.part ?? {};
                const t = part.tokens ?? {};
                steps++;
                cost = add(cost, part.cost);
                tokens.total = add(tokens.total, t.total);
                tokens.input = add(tokens.input, t.input);
                tokens.output = add(tokens.output, t.output);
                tokens.reasoning = add(tokens.reasoning, t.reasoning);
                tokens.cache_read = add(tokens.cache_read, t.cache?.read);
                tokens.cache_write = add(tokens.cache_write, t.cache?.write);
                if (part.reason === 'stop' || part.reason === 'end_turn')
                    completed = true;
            } else if (event.type === 'tool_use') {
                tools.add(event.part?.callID ?? event.part?.id ?? `${tools.size}`);
            }
        } else {
            const data = event.data ?? {};
            if (event.type === 'usage.updated') {
                steps++;
                if (data.kind !== 'delta') {
                    cost = null;
                    for (const key of Object.keys(tokens) as (keyof Tokens)[])
                        tokens[key] = null;
                    continue;
                }
                cost = add(cost, data.cost_usd);
                tokens.total = add(tokens.total, data.total_tokens);
                tokens.input = add(tokens.input, data.input_tokens);
                tokens.output = add(tokens.output, data.output_tokens);
                tokens.reasoning = add(tokens.reasoning, data.reasoning_tokens);
                tokens.cache_read = add(tokens.cache_read, data.cache_read_tokens);
                tokens.cache_write = add(tokens.cache_write, data.cache_write_tokens);
            } else if (event.type === 'tool.started') {
                tools.add(data.id ?? `${tools.size}`);
            } else if (
                event.type === 'run.completed' ||
                (event.type === 'turn.completed' && data.reason === 'stop')
            ) {
                completed = true;
            }
        }
    }
    if (!steps) {
        cost = null;
        for (const key of Object.keys(tokens) as (keyof Tokens)[]) tokens[key] = null;
    }
    completed &&= !errored;
    return {
        completed,
        cost_usd: cost,
        tokens,
        steps,
        tool_calls: tools.size,
        accounting_complete:
            completed &&
            steps > 0 &&
            cost !== null &&
            Object.values(tokens).every((v) => v !== null),
    };
}
