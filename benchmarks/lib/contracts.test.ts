import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArms, parseModels, positiveInteger } from '../workbenchmark.ts';
import { emptyMetrics, parseEvents } from './metrics.ts';
import {
    aggregate,
    loadResults,
    markdown,
    mergeCampaigns,
    valueMetrics,
    writeReport,
} from './report.ts';
import { quote } from './runtime.ts';
import {
    listTasks,
    loadTask,
    modelSlug,
    parseGrade,
    trialName,
    type Verdict,
    validateTask,
} from './spec.ts';
import {
    diagnosticTools,
    discoverWorkbenchExport,
    selectNativeExport,
} from './trace.ts';
import {
    checkCommand,
    gradingBrief,
    pinModel,
    prepareFixture,
    stagePlainControl,
    submissionArchiveCommand,
    type TrialResult,
    tally,
} from './trial.ts';

const temp: string[] = [];
function directory() {
    const dir = mkdtempSync(join(tmpdir(), 'workbenchmark-test-'));
    temp.push(dir);
    return dir;
}
afterEach(() => {
    for (const dir of temp.splice(0)) rmSync(dir, { recursive: true, force: true });
});
// Archives through a real container, so it needs a Docker engine.
test.skipIf(!Bun.which('docker'))(
    'submission archive excludes node_modules and task-declared paths, not unrelated directories',
    () => {
        const root = directory();
        const project = join(root, 'project with spaces');
        mkdirSync(join(project, 'scratch', '.cache'), { recursive: true });
        mkdirSync(join(project, 'other'), { recursive: true });
        mkdirSync(join(project, 'node_modules', 'dep'), { recursive: true });
        writeFileSync(
            join(project, 'scratch', '.cache', 'start-secrets'),
            'runtime-only',
            {
                mode: 0o000,
            }
        );
        writeFileSync(join(project, 'other', 'data.txt'), 'kept');
        writeFileSync(
            join(project, 'node_modules', 'dep', 'index.js'),
            'module.exports = 1;'
        );
        writeFileSync(join(project, 'app.js'), 'export default 1;');
        const archive = join(root, 'submission.tar.gz');
        const result = Bun.spawnSync([
            'bash',
            '-c',
            submissionArchiveCommand(project, archive, ['scratch/.cache']),
        ]);
        expect(result.exitCode).toBe(0);
        const listing = Bun.spawnSync(['tar', '-tzf', archive]);
        expect(listing.exitCode).toBe(0);
        const names = listing.stdout.toString();
        expect(names).not.toContain('scratch/.cache');
        expect(names).not.toContain('node_modules');
        for (const file of ['other/data.txt', 'app.js']) expect(names).toContain(file);
        const content = Bun.spawnSync(['tar', '-xOzf', archive, './other/data.txt']);
        expect(content.exitCode).toBe(0);
        expect(content.stdout.toString()).toBe('kept');
    }
);
const task = () => ({
    version: 1,
    id: 'example',
    workbench: 'example',
    title: 'Example task',
    fixture: { kind: 'empty' },
    criteria: [{ id: 'works', text: 'It works' }],
});
const verdict = (
    status: Verdict['status'],
    kind: Verdict['kind'] = 'criterion'
): Verdict => ({
    id: 'works',
    title: 'Works',
    kind,
    status,
    pass: status === 'pass',
    evidence: 'Executed a probe',
});
const trial = (
    status: TrialResult['status'],
    cost: number | null = 1
): TrialResult => ({
    version: 1,
    trial: 'example',
    task: 'example',
    workbench: 'example',
    arm: 'plain',
    rep: 1,
    model: 'test',
    started_at: '2026-01-01',
    metrics: {
        ...emptyMetrics(),
        elapsed_ms: 1000,
        cost_usd: cost,
        accounting_complete: cost !== null,
        tokens: { ...emptyMetrics().tokens, total: 10 },
    },
    verdicts: [verdict(status === 'passed' ? 'pass' : 'fail')],
    ...tally([verdict(status === 'passed' ? 'pass' : 'fail')]),
    status,
    versions: {},
    ...(status === 'infra_error' ? { infra_error: 'grader crashed' } : {}),
});

describe('task contract', () => {
    test('both arms deliver the same scoped permissions through packaged runner config', () => {
        const bench = resolve(import.meta.dir, '..');
        const paths = {
            bench,
            workbenches: join(bench, '.workbenches'),
            tasks: join(bench, 'tasks'),
            results: directory(),
            work: directory(),
            imageCache: directory(),
        };
        const plain = stagePlainControl(paths, paths.work, false);
        const expected = {
            '*': 'deny',
            '/workbench/*': 'allow',
            '/runtime-assets/*': 'allow',
            '/tmp/*': 'allow',
        };
        for (const pkg of [
            plain,
            ...['example', 'grader'].map((n) => join(paths.workbenches, n)),
        ]) {
            expect(readFileSync(join(pkg, 'workbench.yml'), 'utf8')).toContain(
                'runner_config: ./opencode.json'
            );
            expect(
                JSON.parse(readFileSync(join(pkg, 'opencode.json'), 'utf8')).permission
                    .external_directory
            ).toEqual(expected);
        }
    });
    test('a required (non-practice) criterion failing or untested blocks a working result', () => {
        const spec = validateTask({
            ...task(),
            criteria: [{ id: 'required-check', text: 'Must actually work' }],
        });
        for (const status of ['fail', 'not-tested'] as const) {
            const verdicts = parseGrade(
                {
                    version: 1,
                    verdicts: [
                        {
                            id: 'required-check',
                            status,
                            evidence: 'Synthetic contract-test observation',
                            detail: 'Requested behavior is missing or could not be executed',
                        },
                    ],
                },
                spec.criteria!
            );
            expect(tally(verdicts).works).toBe(false);
            expect(tally(verdicts).status).toBe(
                status === 'fail' ? 'failed' : 'inconclusive'
            );
        }
    });
    test('all shipped tasks validate without results or Docker', () => {
        const root = resolve(import.meta.dir, '../tasks');
        for (const id of listTasks(root)) expect(loadTask(root, id).version).toBe(1);
    });
    test('rejects recipes with missing grading, unknown fields, traversal, or duplicate IDs', () => {
        expect(() => validateTask({ ...task(), criteria: [] })).toThrow();
        expect(() => validateTask({ ...task(), image: 'task-image' })).toThrow(
            'Unknown'
        );
        expect(() =>
            validateTask({ ...task(), fixture: { kind: 'dir', path: '../answers' } })
        ).toThrow();
        expect(() =>
            validateTask({
                ...task(),
                gates: [{ id: 'works', title: 'duplicate', run: 'true' }],
            })
        ).toThrow('Duplicate');
        expect(() =>
            validateTask({
                ...task(),
                fixture: {
                    kind: 'git',
                    url: 'https://example.org/repo',
                    commit: 'main',
                },
            })
        ).toThrow('SHA');
    });
    test('rejects invalid CLI selections rather than running zero attempts', () => {
        for (const n of ['0', '-1', 'NaN', '1.5', 'Infinity'])
            expect(() => positiveInteger(n, 'reps')).toThrow();
        expect(parseArms('plain,workbench')).toEqual(['plain', 'workbench']);
        expect(() => parseArms('plain,plain')).toThrow();
        expect(() => parseArms('other')).toThrow();
    });
});
describe('multi-model campaigns', () => {
    test('model slugs are derived from the last path segment and reject unsafe ids', () => {
        expect(modelSlug('vendor/Model-X.1')).toBe('model-x.1');
        expect(modelSlug('openai/gpt-5.6-terra')).toBe('gpt-5.6-terra');
        expect(() => modelSlug('vendor/weird name!')).toThrow();
        expect(() => modelSlug('')).toThrow();
    });
    test('trial names embed the task, model slug, arm, and rep', () => {
        expect(trialName('task', 'vendor/Model-X', 'plain', 2)).toBe(
            'task__model-x__plain__2'
        );
        expect(trialName('task', 'openai/gpt-5.6-terra', 'workbench', 1)).toBe(
            'task__gpt-5.6-terra__workbench__1'
        );
    });
    test('--models accepts distinct models and rejects models that collide on slug', () => {
        expect(parseModels('vendor/a,vendor/b')).toEqual(['vendor/a', 'vendor/b']);
        expect(() => parseModels('vendor/model,other/model')).toThrow();
    });
    test('pinModel replaces only the declared model block, leaving the rest of the package untouched', () => {
        const dir = directory();
        writeFileSync(
            join(dir, 'workbench.yml'),
            [
                'spec: 0',
                'version: 1.0.0',
                'name: example',
                'model:',
                '  id: old/model',
                '  routes:',
                '    - provider: openrouter',
                '      model: old/model',
                'instructions: ./instructions.md',
                '',
            ].join('\n')
        );
        pinModel(dir, 'vendor/new-model');
        const updated = readFileSync(join(dir, 'workbench.yml'), 'utf8');
        expect(updated).toContain('id: vendor/new-model');
        expect(updated).toContain('model: vendor/new-model');
        expect(updated).toContain('instructions: ./instructions.md');
        expect(updated).not.toContain('old/model');
    });
    test('pinModel requires a declared model to replace', () => {
        const dir = directory();
        writeFileSync(join(dir, 'workbench.yml'), 'spec: 0\nname: example\n');
        expect(() => pinModel(dir, 'vendor/new-model')).toThrow();
    });
});
describe('grading contract', () => {
    const criteria = [{ id: 'works', text: 'It works' }];
    test('requires complete evidenced output with actual boolean-independent statuses', () => {
        const valid = {
            version: 1,
            verdicts: [{ id: 'works', status: 'pass', evidence: 'GET / -> 200' }],
        };
        expect(parseGrade(valid, criteria)[0]!.pass).toBe(true);
        for (const v of [
            [],
            [{ id: 'works', status: 'pass' }],
            [{ id: 'works', status: 'fail', evidence: 'error' }],
            [{ id: 'other', status: 'pass', evidence: 'x' }],
            [...valid.verdicts, ...valid.verdicts],
        ])
            expect(() => parseGrade({ version: 1, verdicts: v }, criteria)).toThrow();
        expect(() =>
            parseGrade(
                {
                    version: 1,
                    verdicts: [{ id: 'works', pass: 'false', evidence: 'x' }],
                },
                criteria
            )
        ).toThrow();
    });
    test('missing coverage is inconclusive; practices do not change working status', () => {
        expect(tally([verdict('not-tested')]).status).toBe('inconclusive');
        expect(tally([verdict('pass'), verdict('fail', 'practice')]).works).toBe(true);
        expect(tally([verdict('fail'), verdict('not-tested')]).status).toBe('failed');
        expect(tally([]).works).toBe(false);
    });
    test('brief has no arm, agent transcript, or benchmark repository mount', () => {
        const brief = gradingBrief(
            validateTask(task()),
            'Do this',
            '/evidence/result.json',
            '/evidence/checks',
            []
        );
        expect(brief).not.toContain('plain');
        expect(brief).not.toContain('/bench');
        expect(brief).toContain('Do this');
    });
});
describe('measurement and reporting', () => {
    test('value counts failed-attempt spend and never invents a cost per success', () => {
        expect(valueMetrics([trial('passed'), trial('failed')])).toEqual({
            total_actor_tokens: 20,
            total_actor_cost_usd: 2,
            working_per_million_tokens: 50000,
            working_per_dollar: 0.5,
            actor_cost_per_working_result: 2,
        });
        expect(
            valueMetrics([trial('failed')]).actor_cost_per_working_result
        ).toBeNull();
        expect(valueMetrics([trial('failed')]).working_per_million_tokens).toBe(0);
        expect(
            valueMetrics([trial('passed'), trial('failed', null)])
                .working_per_million_tokens
        ).toBeNull();
        expect(
            valueMetrics([trial('passed'), trial('infra_error')]).working_per_dollar
        ).toBeNull();
        expect(valueMetrics([]).total_actor_tokens).toBeNull();
    });
    const native = {
        type: 'step_finish',
        part: {
            id: 'one',
            reason: 'stop',
            cost: 0.25,
            tokens: {
                total: 10,
                input: 5,
                output: 3,
                reasoning: 2,
                cache: { read: 0, write: 0 },
            },
        },
    };
    function events(values: unknown[]) {
        const file = join(directory(), 'events.ndjson');
        writeFileSync(file, values.map((v) => JSON.stringify(v)).join('\n'));
        return file;
    }
    test('identical native and normalized observations produce identical totals; duplicates count once', () => {
        const normalized = {
            type: 'usage.updated',
            run_id: 'one',
            sequence: 1,
            data: {
                kind: 'delta',
                cost_usd: 0.25,
                total_tokens: 10,
                input_tokens: 5,
                output_tokens: 3,
                reasoning_tokens: 2,
                cache_read_tokens: 0,
                cache_write_tokens: 0,
            },
        };
        const plain = parseEvents(events([native, native]), 'plain'),
            wb = parseEvents(
                events([normalized, normalized, { type: 'run.completed' }]),
                'workbench'
            );
        expect(plain).toEqual(wb);
        expect(plain.accounting_complete).toBe(true);
        expect(plain.cost_usd).toBe(0.25);
    });
    test('missing or truncated accounting is never a free successful run', () => {
        expect(parseEvents(events([]), 'plain').cost_usd).toBeNull();
        const missing = parseEvents(
            events([{ ...native, part: { ...native.part, cost: undefined } }]),
            'plain'
        );
        expect(missing.cost_usd).toBeNull();
        expect(
            parseEvents(events([native, { type: 'error' }]), 'plain')
                .accounting_complete
        ).toBe(false);
    });
    test('reports include losses, separate infrastructure errors, and preserve unknown usage', () => {
        const cells = aggregate([
            trial('passed'),
            trial('failed', null),
            trial('infra_error'),
        ]);
        expect(cells[0]!.runs).toBe(2);
        expect(cells[0]!.works).toBe(1);
        expect(cells[0]!.infra_errors).toBe(1);
        expect(cells[0]!.median_cost_usd).toBeNull();
        expect(markdown(cells)).toContain('unknown');
        expect(markdown([])).toContain('No completed');
    });
    test('old result formats are refused, not migrated into new reports', () => {
        const dir = directory();
        mkdirSync(join(dir, 'trials', 'old'), { recursive: true });
        writeFileSync(join(dir, 'trials', 'old', 'result.json'), '{}');
        expect(() => loadResults(dir)).toThrow('Obsolete');
    });
    test('cells and bars.json group by task, model, and arm', () => {
        const dir = directory();
        const write = (
            model: string,
            arm: 'plain' | 'workbench',
            status: TrialResult['status']
        ) => {
            const name = trialName('task', model, arm, 1);
            mkdirSync(join(dir, 'trials', name), { recursive: true });
            writeFileSync(
                join(dir, 'trials', name, 'result.json'),
                JSON.stringify({ ...trial(status), task: 'task', arm, model })
            );
        };
        write('vendor/a', 'plain', 'passed');
        write('vendor/a', 'workbench', 'passed');
        write('vendor/b', 'plain', 'failed');
        const cells = writeReport(dir);
        expect(cells.map((c) => `${c.task}/${c.model}/${c.arm}`).sort()).toEqual([
            'task/a/plain',
            'task/a/workbench',
            'task/b/plain',
        ]);
        const matrix = JSON.parse(readFileSync(join(dir, 'matrix.json'), 'utf8'));
        expect(matrix.summary.map((s: any) => `${s.model}/${s.arm}`).sort()).toEqual([
            'a/plain',
            'a/workbench',
            'b/plain',
        ]);
        expect(
            matrix.summary.find((s: any) => s.model === 'a' && s.arm === 'plain')
                .actor_dollars_per_working_result
        ).toBe(1);
        expect(
            matrix.summary.find((s: any) => s.model === 'b' && s.arm === 'plain')
                .actor_dollars_per_working_result
        ).toBeNull();
        const bars = JSON.parse(readFileSync(join(dir, 'bars.json'), 'utf8'));
        const task = bars.tasks.find((t: any) => t.task === 'task');
        expect(task.bars.map((b: any) => `${b.model}/${b.arm}`).sort()).toEqual([
            'a/plain',
            'a/workbench',
            'b/plain',
        ]);
        expect(
            task.bars.find((b: any) => b.model === 'b' && b.arm === 'plain')
                .cost_per_working_result_usd
        ).toBeNull();
        expect(
            task.bars.find((b: any) => b.model === 'a' && b.arm === 'plain')
                .cost_per_working_result_usd
        ).toBe(1);
        expect(readFileSync(join(dir, 'matrix.md'), 'utf8')).toContain('never passed');
    });
    test('merging campaigns keeps only the last campaign per cell, never a mix', () => {
        const cell = (arm: 'plain' | 'workbench', status: TrialResult['status']) => ({
            ...trial(status),
            task: 'a',
            model: 'vendor/x',
            arm,
        });
        const first = [cell('plain', 'passed'), cell('workbench', 'failed')];
        const second = [cell('workbench', 'passed')];
        const { results, sources } = mergeCampaigns([
            { name: 'first', results: first },
            { name: 'second', results: second },
        ]);
        // The plain cell only ever appeared in "first", so it is kept from there.
        expect(results.filter((r) => r.arm === 'plain')).toEqual([first[0]]);
        // The workbench cell appeared in both; only "second"'s attempt survives, never both.
        expect(results.filter((r) => r.arm === 'workbench')).toEqual([second[0]]);
        expect(results).toHaveLength(2);
        expect(sources).toEqual([
            { task: 'a', model: 'x', arm: 'plain', campaign: 'first', attempts: 1 },
            {
                task: 'a',
                model: 'x',
                arm: 'workbench',
                campaign: 'second',
                attempts: 1,
            },
        ]);
    });
});

describe('native trace selection', () => {
    function nativeSession(home: string, name: string, id = 'ses_native_123') {
        const session = join(home, '.workbench', 'sessions', name);
        mkdirSync(join(session, 'native'), { recursive: true });
        writeFileSync(
            join(session, 'session.json'),
            JSON.stringify({ native_session_id: id })
        );
        writeFileSync(join(session, 'native', 'opencode.sqlite'), 'fixture');
    }

    test('selects exactly one complete workbench native session', () => {
        const home = directory();
        nativeSession(home, 'owned');
        expect(discoverWorkbenchExport(home)).toEqual({
            sessionId: 'ses_native_123',
            database: join(
                home,
                '.workbench',
                'sessions',
                'owned',
                'native',
                'opencode.sqlite'
            ),
        });
    });

    test('rejects missing, malformed, and ambiguous workbench session state', () => {
        const missing = directory();
        expect(() => discoverWorkbenchExport(missing)).toThrow(
            'Missing Workbench sessions'
        );

        const malformed = directory();
        const metadata = join(malformed, '.workbench', 'sessions', 'owned');
        mkdirSync(metadata, { recursive: true });
        writeFileSync(join(metadata, 'session.json'), '{');
        expect(() => discoverWorkbenchExport(malformed)).toThrow(
            'Malformed session metadata'
        );

        const ambiguous = directory();
        nativeSession(ambiguous, 'one', 'ses_one');
        nativeSession(ambiguous, 'two', 'ses_two');
        expect(() => discoverWorkbenchExport(ambiguous)).toThrow('exactly one');
    });

    test('plain trace selection requires a safe saved session id', () => {
        const home = directory();
        expect(selectNativeExport(home, 'plain', 'ses_plain-1')).toEqual({
            sessionId: 'ses_plain-1',
        });
        expect(() => selectNativeExport(home, 'plain')).toThrow('requires');
        expect(() => selectNativeExport(home, 'plain', 'bad id')).toThrow('Invalid');
        expect(() => selectNativeExport(home, 'plain', '--help')).toThrow('Invalid');
        expect(() => selectNativeExport(home, 'workbench', 'ses_plain')).toThrow(
            'must not'
        );
    });
});

describe('native tool diagnostic scrubber', () => {
    test('keeps only tool diagnostics and removes runner context and credentials', () => {
        const trace = diagnosticTools({
            info: { provider: { apiKey: 'sk-top-level' }, prompt: 'do not retain' },
            messages: [
                {
                    info: { reasoning: 'do not retain', text: 'do not retain' },
                    parts: [
                        { type: 'text', text: 'assistant text must not be retained' },
                        {
                            type: 'tool',
                            callID: 'call_1',
                            tool: 'bash',
                            state: {
                                status: 'error',
                                input: {
                                    command:
                                        'API_KEY=abc123 curl -H "Authorization: Bearer token-value"',
                                    prompt: 'hidden prompt',
                                    reasoning: 'hidden chain',
                                    attachments: [{ name: 'hidden' }],
                                },
                                output: {
                                    api_key: 'lowercase-key',
                                    token: 'object-token',
                                    OPENROUTER_API_KEY: 'provider-key',
                                    SERVICE_ANON_KEY: 'anon-key',
                                    ACCESS_TOKEN: 'access-token',
                                    text: 'sk-output-secret Bearer another-token Basic dXNlcjpwYXNz https://user:password@example.test/path',
                                },
                                error: 'OPENROUTER_API_KEY=value',
                            },
                        },
                    ],
                },
            ],
        });
        expect(trace).toEqual({
            version: 1,
            kind: 'tool-diagnostics',
            tools: [
                {
                    id: 'call_1',
                    name: 'bash',
                    status: 'error',
                    input: {
                        command:
                            'API_KEY=[REDACTED] curl -H "Authorization: Bearer [REDACTED]"',
                    },
                    output: {
                        api_key: '[REDACTED]',
                        token: '[REDACTED]',
                        OPENROUTER_API_KEY: '[REDACTED]',
                        SERVICE_ANON_KEY: '[REDACTED]',
                        ACCESS_TOKEN: '[REDACTED]',
                        text: '[REDACTED] Bearer [REDACTED] Basic [REDACTED] https://user:[REDACTED]@example.test/path',
                    },
                    error: 'OPENROUTER_API_KEY=[REDACTED]',
                },
            ],
        });
        expect(JSON.stringify(trace)).not.toContain('assistant text');
        expect(JSON.stringify(trace)).not.toContain('hidden prompt');
        expect(JSON.stringify(trace)).not.toContain('hidden chain');
    });

    test('rejects malformed native exports', () => {
        expect(() => diagnosticTools({ messages: {} })).toThrow('no messages');
    });
});
test('fixture preparation preserves ordinary project only and handles spaces', async () => {
    const root = directory(),
        tasks = join(root, 'task folders'),
        project = join(root, 'project space');
    mkdirSync(join(tasks, 'example', 'fixture'), { recursive: true });
    mkdirSync(join(tasks, 'example', 'checks'));
    writeFileSync(join(tasks, 'example', 'fixture', 'README.md'), 'ordinary project');
    writeFileSync(join(tasks, 'example', 'checks', 'secret.sh'), 'exit 0');
    const spec = validateTask({ ...task(), fixture: { kind: 'dir', path: 'fixture' } });
    await prepareFixture(
        {
            bench: root,
            tasks,
            workbenches: root,
            results: root,
            work: root,
            imageCache: root,
        },
        spec,
        project,
        root
    );
    expect(readFileSync(join(project, 'README.md'), 'utf8')).toBe('ordinary project');
    expect(() => readFileSync(join(project, 'checks', 'secret.sh'))).toThrow();
    expect(checkCommand('./checks/seed.sh', "/path with 'quote")).toContain(
        '"$CHECKS_DIR"/seed.sh'
    );
    expect(quote("a'b")).toBe("'a'\"'\"'b'");
});
