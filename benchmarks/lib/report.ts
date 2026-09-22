import {
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { modelSlug } from './spec.ts';
import type { TrialResult } from './trial.ts';

/** Which campaign a merged cell's attempts came from, and how many there are. */
export interface Source {
    task: string;
    model: string;
    arm: string;
    campaign: string;
    attempts: number;
}

export interface Cell {
    task: string;
    workbench: string;
    model: string;
    arm: string;
    runs: number;
    works: number;
    failed: number;
    inconclusive: number;
    infra_errors: number;
    median_seconds: number | null;
    median_cost_usd: number | null;
    median_tokens: number | null;
    check_pass_rate: number | null;
    practice_pass_rate: number | null;
    complete_usage_runs: number;
}
export function median(values: (number | null)[]): number | null {
    if (!values.length || values.some((v) => v === null)) return null;
    const sorted = (values as number[]).toSorted((a, b) => a - b),
        mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}
export function loadResults(directory: string): TrialResult[] {
    const trials = join(directory, 'trials');
    if (!existsSync(trials)) return [];
    return readdirSync(trials)
        .sort()
        .flatMap((name) => {
            const path = join(trials, name, 'result.json');
            if (!existsSync(path)) return [];
            const result = JSON.parse(readFileSync(path, 'utf8'));
            if (result.version !== 1)
                throw new Error(
                    `Obsolete result excluded: ${path}. Start a new campaign.`
                );
            if (
                !Array.isArray(result.verdicts) ||
                !result.metrics ||
                !['plain', 'workbench'].includes(result.arm)
            )
                throw new Error(`Invalid result: ${path}`);
            return [result as TrialResult];
        });
}
/**
 * Merge results from several campaigns, taken in order. A cell is (task, model slug, arm).
 * For each cell, only attempts from the LAST listed campaign that has any attempt for that
 * cell are kept; attempts from earlier campaigns for that same cell are dropped entirely, so
 * a cell's attempts are never mixed across campaigns. Matches the policy that a re-run
 * Workbench cell replaces the earlier one in full, while an untouched cell keeps its
 * original (often the plain arm's first-campaign) attempts.
 */
export function mergeCampaigns(campaigns: { name: string; results: TrialResult[] }[]): {
    results: TrialResult[];
    sources: Source[];
} {
    const cellKey = (r: TrialResult) => `${r.task}/${modelSlug(r.model)}/${r.arm}`;
    const lastIndex = new Map<string, number>();
    campaigns.forEach((c, index) => {
        for (const r of c.results) lastIndex.set(cellKey(r), index);
    });
    const results = campaigns.flatMap((c, index) =>
        c.results.filter((r) => lastIndex.get(cellKey(r)) === index)
    );
    const cells = new Map<string, Source>();
    for (const r of results) {
        const key = cellKey(r);
        const existing = cells.get(key);
        if (existing) existing.attempts += 1;
        else
            cells.set(key, {
                task: r.task,
                model: modelSlug(r.model),
                arm: r.arm,
                campaign: campaigns[lastIndex.get(key)!]!.name,
                attempts: 1,
            });
    }
    const sources = [...cells.values()].sort(
        (a, b) =>
            a.task.localeCompare(b.task) ||
            a.model.localeCompare(b.model) ||
            a.arm.localeCompare(b.arm)
    );
    return { results, sources };
}
export function aggregate(results: TrialResult[]): Cell[] {
    const groups = new Map<string, TrialResult[]>();
    for (const r of results) {
        const key = `${r.task}/${modelSlug(r.model)}/${r.arm}`;
        groups.set(key, [...(groups.get(key) ?? []), r]);
    }
    return [...groups.values()]
        .map((all) => {
            const trials = all.filter((r) => !r.infra_error),
                rate = (practice: boolean) => {
                    const vs = trials.flatMap((r) =>
                        r.verdicts.filter((v) => (v.kind === 'practice') === practice)
                    );
                    return vs.length
                        ? vs.filter((v) => v.status === 'pass').length / vs.length
                        : null;
                };
            return {
                task: all[0]!.task,
                workbench: all[0]!.workbench,
                model: modelSlug(all[0]!.model),
                arm: all[0]!.arm,
                runs: trials.length,
                works: trials.filter((r) => r.status === 'passed').length,
                failed: trials.filter((r) => r.status === 'failed').length,
                inconclusive: trials.filter((r) => r.status === 'inconclusive').length,
                infra_errors: all.length - trials.length,
                median_seconds: median(trials.map((r) => r.metrics.elapsed_ms / 1000)),
                median_cost_usd: median(
                    trials.map((r) =>
                        r.metrics.accounting_complete ? r.metrics.cost_usd : null
                    )
                ),
                median_tokens: median(
                    trials.map((r) =>
                        r.metrics.accounting_complete ? r.metrics.tokens.total : null
                    )
                ),
                complete_usage_runs: trials.filter((r) => r.metrics.accounting_complete)
                    .length,
                check_pass_rate: rate(false),
                practice_pass_rate: rate(true),
            };
        })
        .sort(
            (a, b) =>
                a.task.localeCompare(b.task) ||
                a.model.localeCompare(b.model) ||
                a.arm.localeCompare(b.arm)
        );
}
const number = (n: number | null, digits = 0) =>
    n === null ? 'unknown' : n.toFixed(digits);
const percent = (n: number | null) => (n === null ? 'n/a' : `${Math.round(n * 100)}%`);
export function valueMetrics(results: TrialResult[]) {
    const working = results.filter((r) => r.status === 'passed').length;
    const complete =
        results.length > 0 && results.every((r) => r.metrics.accounting_complete);
    const sum = (read: (r: TrialResult) => number | null) =>
        complete &&
        results.every((r) => {
            const n = read(r);
            return n !== null && Number.isFinite(n) && n >= 0;
        })
            ? results.reduce((n, r) => n + read(r)!, 0)
            : null;
    const tokens = sum((r) => r.metrics.tokens.total),
        cost = sum((r) => r.metrics.cost_usd);
    const valid = !results.some(
        (r) => r.status === 'infra_error' || r.status === 'inconclusive'
    );
    return {
        total_actor_tokens: tokens,
        total_actor_cost_usd: cost,
        working_per_million_tokens:
            valid && tokens !== null && tokens > 0 ? (working * 1e6) / tokens : null,
        working_per_dollar: valid && cost !== null && cost > 0 ? working / cost : null,
        actor_cost_per_working_result:
            valid && cost !== null && working > 0 ? cost / working : null,
    };
}
export function markdown(cells: Cell[]): string {
    return [
        '# Workbenchmark',
        '',
        '| Task | Model | Arm | Works | Failed | Inconclusive | Infra errors | Median seconds | Median model cost | Median tokens | Behavior | Practices |',
        '| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
        ...cells.map(
            (c) =>
                `| ${c.task} | ${c.model} | ${c.arm} | ${c.works}/${c.runs} | ${c.failed} | ${c.inconclusive} | ${c.infra_errors} | ${number(c.median_seconds, 1)} | ${c.median_cost_usd === null ? 'unknown' : `$${number(c.median_cost_usd, 4)}`} | ${number(c.median_tokens)} | ${percent(c.check_pass_rate)} | ${percent(c.practice_pass_rate)} |`
        ),
        '',
        cells.length ? '' : 'No completed attempts yet.',
        'Medians include all graded attempts, including failures. Infrastructure errors are counted separately. Missing or incomplete usage is unknown, never zero.',
        'Model cost is native-reported agent usage, not an invoice total. Grader usage is retained separately in each result. Prepared runs record runtime acquisition for both arms separately in preparation_ms; cold runs include it in elapsed_ms. Generic and product image preloads are outside the clock.',
        'Privileged Docker daemons separate trial resources. They are not a security sandbox. No cross-task speedup is inferred from these rows.',
        '',
    ].join('\n');
}
export function assessmentTable(results: TrialResult[]): string {
    const cell = (s: string) => s.replaceAll('|', '\\|').replaceAll('\n', ' ');
    return [
        '## Assessment by dimension',
        '',
        'Full pass still requires every required dimension. A failure in one is not a claim that every other dimension failed.',
        'These are separate verdicts, not interchangeable quality points or a weighted score.',
        '',
        '| Task | Arm | Rep | Dimension | Status |',
        '| --- | --- | ---: | --- | --- |',
        ...results.flatMap((r) =>
            r.verdicts.map(
                (v) =>
                    '| ' +
                    [r.task, r.arm, String(r.rep), v.id, v.status]
                        .map(cell)
                        .join(' | ') +
                    ' |'
            )
        ),
        '',
    ].join('\n');
}
/**
 * Actor dollars per working result: total cost of ALL attempts in the group
 * (including failures), divided by passing attempts. Null with zero passes.
 */
function costPerWorkingResult(selected: TrialResult[]) {
    const working = selected.filter((r) => r.status === 'passed').length;
    if (!working) return null;
    const complete = selected.every((r) => r.metrics.accounting_complete);
    if (!complete) return null;
    const cost = selected.reduce((sum, r) => sum + (r.metrics.cost_usd ?? 0), 0);
    return cost / working;
}
export interface ReportMeta {
    sources: Source[];
    campaigns: string[];
}
export interface Report {
    cells: Cell[];
    matrixJson: object;
    barsJson: object;
    matrixMd: string;
}
/** Pure aggregation: turns loaded results (optionally merged across campaigns) into the
 * matrix.json / bars.json / matrix.md content, without touching the filesystem. */
export function buildReport(results: TrialResult[], meta?: ReportMeta): Report {
    const cells = aggregate(results);
    const models = [...new Set(results.map((r) => modelSlug(r.model)))].sort();
    const summary = models.flatMap((model) =>
        (['plain', 'workbench'] as const).flatMap((arm) => {
            const selected = results.filter(
                (r) => modelSlug(r.model) === model && r.arm === arm
            );
            if (!selected.length) return [];
            const working = selected.filter((r) => r.status === 'passed').length,
                actorCostAllAttempts = selected.reduce(
                    (sum, r) => sum + (r.metrics.cost_usd ?? 0),
                    0
                );
            return [
                {
                    model,
                    arm,
                    ...valueMetrics(selected),
                    attempts: selected.length,
                    working,
                    failed: selected.filter((r) => r.status === 'failed').length,
                    inconclusive: selected.filter((r) => r.status === 'inconclusive')
                        .length,
                    infrastructure_errors: selected.filter(
                        (r) => r.status === 'infra_error'
                    ).length,
                    reported_actor_cost_usd: actorCostAllAttempts,
                    actor_dollars_per_working_result: costPerWorkingResult(selected),
                    incomplete_actor_usage: selected.filter(
                        (r) => !r.metrics.accounting_complete
                    ).length,
                    reported_grader_cost_usd: selected.reduce(
                        (sum, r) => sum + (r.grading_metrics?.cost_usd ?? 0),
                        0
                    ),
                    actor_seconds: selected.reduce(
                        (sum, r) => sum + r.metrics.elapsed_ms / 1000,
                        0
                    ),
                    preparation_seconds: selected.reduce(
                        (sum, r) => sum + (r.metrics.preparation_ms ?? 0) / 1000,
                        0
                    ),
                },
            ];
        })
    );
    const tasks = [...new Set(results.map((r) => r.task))].sort();
    const bars = tasks.map((task) => ({
        task,
        bars: models.flatMap((model) =>
            (['plain', 'workbench'] as const).flatMap((arm) => {
                const selected = results.filter(
                    (r) =>
                        r.task === task && modelSlug(r.model) === model && r.arm === arm
                );
                if (!selected.length) return [];
                return [
                    {
                        model,
                        arm,
                        passed: selected.filter((r) => r.status === 'passed').length,
                        attempts: selected.length,
                        cost_per_working_result_usd: costPerWorkingResult(selected),
                        median_seconds: median(
                            selected.map((r) => r.metrics.elapsed_ms / 1000)
                        ),
                        median_tokens: median(
                            selected.map((r) =>
                                r.metrics.accounting_complete
                                    ? r.metrics.tokens.total
                                    : null
                            )
                        ),
                    },
                ];
            })
        ),
    }));
    const matrixJson = {
        version: 1,
        generated_at: new Date().toISOString(),
        ...(meta ? { campaigns: meta.campaigns, sources: meta.sources } : {}),
        summary,
        cells,
        results,
    };
    const barsJson = {
        version: 1,
        generated_at: new Date().toISOString(),
        ...(meta ? { campaigns: meta.campaigns, sources: meta.sources } : {}),
        tasks: bars,
    };
    const totals = summary
        .map(
            (s) =>
                `${s.model} / ${s.arm}: ${s.working}/${s.attempts} working; ${s.failed} failed; ${s.inconclusive} inconclusive; ${s.infrastructure_errors} infrastructure errors. Reported actor spend $${s.reported_actor_cost_usd.toFixed(4)}${s.incomplete_actor_usage ? ` (incomplete usage in ${s.incomplete_actor_usage} attempts)` : ''}; current grader spend $${s.reported_grader_cost_usd.toFixed(4)}; actor dollars per working result: ${s.actor_dollars_per_working_result === null ? 'never passed' : `$${number(s.actor_dollars_per_working_result, 4)}`}.`
        )
        .join('\n\n');
    const matrixMd =
        markdown(cells) +
        '\n' +
        assessmentTable(results) +
        '\n' +
        totals +
        '\n\n' +
        [
            '| Model | Arm | Total actor tokens | Working / million tokens | Working / dollar | Actor dollars / working result |',
            '| --- | --- | ---: | ---: | ---: | ---: |',
            ...summary.map(
                (s) =>
                    `| ${s.model} | ${s.arm} | ${number(s.total_actor_tokens)} | ${number(s.working_per_million_tokens, 3)} | ${number(s.working_per_dollar, 3)} | ${s.actor_dollars_per_working_result === null ? 'never passed' : number(s.actor_dollars_per_working_result, 4)} |`
            ),
            '',
            'Value denominators include failed attempts. Unknown accounting, infrastructure errors, or inconclusive grading prevent a value comparison. Zero successes do not have a finite cost per success ("never passed"). Pooled values describe only this selected task and model mix, not a universal success rate.',
            '',
        ].join('\n');
    return { cells, matrixJson, barsJson, matrixMd };
}
/** Writes the built report (matrix.json, bars.json, matrix.md) into directory, creating it
 * if needed. Reused by both the single-campaign and merged-campaigns report paths. */
export function writeReportFiles(
    directory: string,
    results: TrialResult[],
    meta?: ReportMeta
): Cell[] {
    mkdirSync(directory, { recursive: true });
    const report = buildReport(results, meta);
    writeFileSync(
        join(directory, 'matrix.json'),
        JSON.stringify(report.matrixJson, null, 2) + '\n',
        { mode: 0o600 }
    );
    writeFileSync(
        join(directory, 'bars.json'),
        JSON.stringify(report.barsJson, null, 2) + '\n',
        { mode: 0o600 }
    );
    writeFileSync(join(directory, 'matrix.md'), report.matrixMd, { mode: 0o600 });
    return report.cells;
}
export function writeReport(directory: string): Cell[] {
    return writeReportFiles(directory, loadResults(directory));
}
