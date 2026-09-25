// A task is a directory: task.json, prompt.md, and whatever scripts and fixture files it needs.
// Nothing about a task lives in the harness.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

export type Arm = 'plain' | 'workbench';

/** Provider model ids such as `vendor/name`. The last segment names result directories. */
export function modelSlug(model: string): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,119}$/.test(model))
        throw new Error(`Invalid model id: ${model}`);
    return model
        .split('/')
        .pop()!
        .toLowerCase()
        .replace(/[^a-z0-9.-]/g, '-');
}
export const trialName = (task: string, model: string, arm: Arm, rep: number) =>
    `${task}__${modelSlug(model)}__${arm}__${rep}`;

export type Fixture =
    | { kind: 'git'; url: string; commit: string; subdir?: string; overlay?: string }
    | { kind: 'dir'; path: string }
    | { kind: 'empty' };

/** A deterministic pass or fail: a command that must exit zero, run in the submission. */
export interface Gate {
    id: string;
    /** Shown in reports and to the grader. */
    title: string;
    /** Shell command, run in the project directory. A task-relative script is just `./checks/boot.sh`. */
    run: string;
    timeoutSeconds?: number;
}

/** Something a person would check by hand. The grader Workbench decides these and records its evidence. */
export interface Criterion {
    id: string;
    /** Plain English. The grader is told to exercise the running app, not to read the code. */
    text: string;
    /**
     * True when this is about how the work was built rather than whether it works.
     * Practice criteria are reported separately and never decide whether a trial works.
     */
    practice?: boolean;
    /** Optional pointer to the practice this reflects, printed in reports. */
    source?: string;
}

export interface TaskSpec {
    version: 1;
    id: string;
    /** Which Workbench the workbench arm runs, and which image carries its CLI. */
    workbench: string;
    title: string;
    fixture: Fixture;
    /** Images copied into the trial's Docker daemon before the clock starts, for both arms. */
    preloadImages?: string[];
    /** Task-relative paths excluded from the graded submission archive, beyond the harness's generic build/dependency excludes. */
    submissionExcludes?: string[];
    timeoutMinutes?: number;
    /** Runs before the agent, to build genuine starting state (a database with data, a running stack). */
    setup?: string;
    /** Prepares the submission for grading (install, migrate, start). Failure fails every gate and criterion. */
    boot?: string;
    gates?: Gate[];
    criteria?: Criterion[];
    retired?: string;
}

export interface Verdict {
    id: string;
    /** `gate` and `criterion` decide whether the work works; `practice` is reported on its own. */
    kind: 'gate' | 'criterion' | 'practice';
    title: string;
    pass: boolean;
    status: 'pass' | 'fail' | 'not-tested';
    detail?: string;
    source?: string;
    /** Commands the grader ran and what they printed. Present for criteria, so any verdict can be audited. */
    evidence?: string;
}

export function loadTask(tasksDir: string, id: string): TaskSpec {
    identifier(id, 'task');
    const file = join(tasksDir, id, 'task.json');
    if (!existsSync(file)) throw new Error(`no task.json in ${join(tasksDir, id)}`);
    const spec = validateTask(JSON.parse(readFileSync(file, 'utf8')));
    if (spec.id !== id) throw new Error(`${file} declares id ${spec.id}`);
    prompt(tasksDir, id);
    if (
        spec.fixture.kind === 'dir' &&
        !existsSync(join(tasksDir, id, spec.fixture.path))
    )
        throw new Error(`${id}: fixture directory missing`);
    if (
        spec.fixture.kind === 'git' &&
        spec.fixture.overlay &&
        !existsSync(join(tasksDir, id, spec.fixture.overlay))
    )
        throw new Error(`${id}: fixture overlay missing`);
    return spec;
}

/** Every directory holding a task.json. Adding a task means adding a directory, nothing else. */
export function listTasks(tasksDir: string): string[] {
    return readdirSync(tasksDir, { withFileTypes: true })
        .filter(
            (entry) =>
                entry.isDirectory() &&
                existsSync(join(tasksDir, entry.name, 'task.json'))
        )
        .map((entry) => entry.name)
        .sort();
}

export function prompt(tasksDir: string, id: string): string {
    const text = readFileSync(join(tasksDir, id, 'prompt.md'), 'utf8').trim();
    if (!text) throw new Error(`${id}: prompt.md is empty`);
    return text;
}

export function identifier(value: unknown, label: string): asserts value is string {
    if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,79}$/.test(value))
        throw new Error(`${label}: use a short lowercase identifier`);
}

function relative(value: unknown, label: string) {
    if (
        typeof value !== 'string' ||
        !value ||
        isAbsolute(value) ||
        value.split(/[\\/]/).some((p) => p === '..') ||
        /[\r\n\0]/.test(value)
    )
        throw new Error(`${label}: expected a relative path inside the task`);
}

export function validateTask(value: unknown): TaskSpec {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('task.json must be an object');
    const t = value as TaskSpec;
    const allowed = [
        'version',
        'id',
        'workbench',
        'title',
        'fixture',
        'preloadImages',
        'submissionExcludes',
        'timeoutMinutes',
        'setup',
        'boot',
        'gates',
        'criteria',
        'retired',
    ];
    for (const key of Object.keys(t))
        if (!allowed.includes(key)) throw new Error(`Unknown task field: ${key}`);
    if (t.version !== 1) throw new Error('task.json version must be 1');
    identifier(t.id, 'task.id');
    identifier(t.workbench, 'task.workbench');
    const text = (v: unknown, label: string) => {
        if (typeof v !== 'string' || !v.trim())
            throw new Error(`${label}: expected nonempty text`);
    };
    text(t.title, 'title');
    for (const key of ['setup', 'boot', 'retired'] as const)
        if (t[key] !== undefined) text(t[key], key);
    const f = t.fixture;
    if (!f || !['git', 'dir', 'empty'].includes(f.kind))
        throw new Error('fixture.kind must be git, dir, or empty');
    const fixtureKeys =
        f.kind === 'git'
            ? ['kind', 'url', 'commit', 'subdir', 'overlay']
            : f.kind === 'dir'
              ? ['kind', 'path']
              : ['kind'];
    if (Object.keys(f).some((k) => !fixtureKeys.includes(k)))
        throw new Error('Unknown fixture field');
    if (f.kind === 'dir') relative(f.path, 'fixture.path');
    if (f.kind === 'git') {
        if (typeof f.url !== 'string' || !/^https:\/\//.test(f.url))
            throw new Error('fixture.url must be HTTPS');
        if (!/^[a-f0-9]{40}$/.test(f.commit))
            throw new Error('fixture.commit must be a full commit SHA');
        if (f.subdir !== undefined) relative(f.subdir, 'fixture.subdir');
        if (f.overlay !== undefined) relative(f.overlay, 'fixture.overlay');
    }
    const positive = (v: unknown, label: string) => {
        if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0)
            throw new Error(`${label}: expected a positive number`);
    };
    if (t.timeoutMinutes !== undefined) positive(t.timeoutMinutes, 'timeoutMinutes');
    if (
        t.preloadImages !== undefined &&
        (!Array.isArray(t.preloadImages) ||
            t.preloadImages.some(
                (i) =>
                    typeof i !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:/@-]*$/.test(i)
            ))
    )
        throw new Error('preloadImages must contain image references');
    if (t.submissionExcludes !== undefined) {
        if (!Array.isArray(t.submissionExcludes))
            throw new Error('submissionExcludes must be an array');
        for (const path of t.submissionExcludes) relative(path, 'submissionExcludes');
    }
    const ids = new Set<string>();
    for (const kind of ['gates', 'criteria'] as const) {
        if (t[kind] !== undefined && !Array.isArray(t[kind]))
            throw new Error(`${kind} must be an array`);
        for (const item of t[kind] ?? []) {
            if (!item || typeof item !== 'object')
                throw new Error(`Invalid ${kind} entry`);
            identifier(item.id, `${kind}.id`);
            if (ids.has(item.id)) throw new Error(`Duplicate check id: ${item.id}`);
            ids.add(item.id);
            const keys =
                kind === 'gates'
                    ? ['id', 'title', 'run', 'timeoutSeconds']
                    : ['id', 'text', 'practice', 'source'];
            if (Object.keys(item).some((k) => !keys.includes(k)))
                throw new Error(`Unknown ${kind} field`);
            if (kind === 'gates') {
                const g = item as Gate;
                text(g.title, 'gate.title');
                text(g.run, 'gate.run');
                if (g.timeoutSeconds !== undefined)
                    positive(g.timeoutSeconds, 'gate.timeoutSeconds');
            } else {
                const c = item as Criterion;
                text(c.text, 'criterion.text');
                if (c.practice !== undefined && typeof c.practice !== 'boolean')
                    throw new Error('practice must be boolean');
                if (c.source !== undefined) text(c.source, 'criterion.source');
            }
        }
    }
    if (!(t.gates?.length || t.criteria?.some((c) => !c.practice)))
        throw new Error(
            'Task needs at least one behavioral criterion or deterministic gate'
        );
    return t;
}

/** The grader supplies observations, never authoritative titles, kinds, or scores. */
export function parseGrade(value: unknown, criteria: Criterion[]): Verdict[] {
    const data = value as { version?: unknown; verdicts?: unknown } | null;
    if (
        !data ||
        data.version !== 1 ||
        !Array.isArray(data.verdicts) ||
        Object.keys(data).some((k) => !['version', 'verdicts'].includes(k))
    )
        throw new Error('Grader must return version 1 and verdicts');
    const entries = data.verdicts as Record<string, unknown>[];
    if (entries.length !== criteria.length)
        throw new Error('Grader returned the wrong number of verdicts');
    const seen = new Set<string>();
    for (const entry of entries) {
        if (
            !entry ||
            typeof entry !== 'object' ||
            typeof entry.id !== 'string' ||
            seen.has(entry.id) ||
            !criteria.some((c) => c.id === entry.id)
        )
            throw new Error('Unknown or duplicate grader criterion');
        seen.add(entry.id);
        if (
            Object.keys(entry).some(
                (k) => !['id', 'status', 'evidence', 'detail'].includes(k)
            )
        )
            throw new Error('Unknown grader verdict field');
        if (!['pass', 'fail', 'not-tested'].includes(String(entry.status)))
            throw new Error('Invalid grader status');
        if (typeof entry.evidence !== 'string' || !entry.evidence.trim())
            throw new Error('Every verdict needs evidence');
        if (entry.detail !== undefined && typeof entry.detail !== 'string')
            throw new Error('Invalid grader detail');
        if (
            entry.status !== 'pass' &&
            (typeof entry.detail !== 'string' || !entry.detail.trim())
        )
            throw new Error('Unsuccessful verdict needs an explanation');
    }
    return criteria.map((c) => {
        const entry = entries.find((e) => e.id === c.id)!;
        return {
            id: c.id,
            title: c.text,
            kind: c.practice ? 'practice' : 'criterion',
            status: entry.status as Verdict['status'],
            pass: entry.status === 'pass',
            evidence: entry.evidence as string,
            ...(entry.detail ? { detail: entry.detail as string } : {}),
            ...(c.source ? { source: c.source } : {}),
        };
    });
}
