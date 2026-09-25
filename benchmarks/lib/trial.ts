// Fresh per-attempt environments. Only selected packages and project inputs reach actors.
// This module owns the trial lifecycle (fixture, actor run, grading, cleanup).
// Package staging lives in packaging.ts, grading in grading.ts, and the shared
// container primitive in container.ts; this file re-exports their public
// surface so existing imports of './trial.ts' keep working unchanged.
import {
    cpSync,
    existsSync,
    mkdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
    AGENT_IMAGE,
    DEFAULT_MODEL,
    ENGINE_IMAGE,
    fingerprint,
    InfraError,
    json,
    must,
    retainNativeTrace,
    runContainer,
} from './container.ts';
import { checkCommand, grade, submissionArchiveCommand, tally } from './grading.ts';
import { emptyMetrics, type Metrics, parseEvents } from './metrics.ts';
import {
    packageCommand,
    pinModel,
    stageChecks,
    stagePackage,
    stagePlainControl,
} from './packaging.ts';
import {
    docker,
    type Paths,
    preloadImages,
    quote,
    removeStaged,
    removeTrial,
    removeWork,
    startDaemon,
} from './runtime.ts';
import {
    type Arm,
    identifier,
    loadTask,
    modelSlug,
    prompt,
    type TaskSpec,
    trialName,
    type Verdict,
} from './spec.ts';

export {
    AGENT_IMAGE,
    DEFAULT_MODEL,
    ENGINE_IMAGE,
    fingerprint,
    InfraError,
} from './container.ts';
export {
    checkCommand,
    gateStatus,
    grade,
    gradingBrief,
    submissionArchiveCommand,
    tally,
} from './grading.ts';
export { pinModel, stagePlainControl } from './packaging.ts';

export interface TrialResult {
    version: 1;
    trial: string;
    task: string;
    workbench: string;
    arm: Arm;
    rep: number;
    model: string;
    started_at: string;
    metrics: Metrics;
    grading_metrics?: Metrics;
    verdicts: Verdict[];
    gates: { passed: number; total: number };
    criteria: { passed: number; total: number };
    practice: { passed: number; total: number };
    works: boolean;
    status: 'passed' | 'failed' | 'inconclusive' | 'infra_error';
    versions: Record<string, string>;
    error?: string;
    infra_error?: string;
    cleanup_warning?: string;
    regraded_at?: string;
}
export async function prepareFixture(
    paths: Paths,
    task: TaskSpec,
    project: string,
    scratch: string
) {
    mkdirSync(project, { recursive: true });
    const dir = join(paths.tasks, task.id),
        f = task.fixture;
    if (f.kind === 'git') {
        const source = join(scratch, 'fixture-source');
        await must(
            `git init -q ${quote(source)} && git -C ${quote(source)} fetch -q --depth 1 ${quote(f.url)} ${quote(f.commit)} && git -C ${quote(source)} checkout -q FETCH_HEAD`
        );
        await must(
            `set -o pipefail; tar --exclude=.git -cf - -C ${quote(join(source, f.subdir ?? '.'))} . | tar -xf - -C ${quote(project)}`
        );
        if (f.overlay) cpSync(join(dir, f.overlay), project, { recursive: true });
    } else if (f.kind === 'dir')
        cpSync(join(dir, f.path), project, { recursive: true });
    await must(
        `git -C ${quote(project)} init -q -b main && git -C ${quote(project)} add -A && git -C ${quote(project)} -c user.name=developer -c user.email=dev@example.com commit -q --allow-empty -m 'Current project' && git -C ${quote(project)} tag baseline`
    );
}
export async function runTrial(o: {
    paths: Paths;
    task: TaskSpec;
    arm: Arm;
    model?: string;
    rep: number;
    campaign: string;
    cold?: boolean;
    log: (m: string) => void;
}): Promise<TrialResult> {
    const { paths, task, arm, rep, log } = o,
        model = o.model ?? DEFAULT_MODEL,
        trial = `trial-${crypto.randomUUID()}`,
        work = join(paths.work, trial),
        gradeWork = join(paths.work, `grade-${crypto.randomUUID()}`);
    const out = join(
            paths.results,
            o.campaign,
            'trials',
            trialName(task.id, model, arm, rep)
        ),
        project = join(work, 'project'),
        daemon = `wbm-${trial}-docker`;
    mkdirSync(out, { recursive: true });
    if (existsSync(join(out, 'result.json')))
        throw new Error(
            `Attempt already exists: ${out}. Use a new campaign or regrade.`
        );
    let metrics = emptyMetrics(),
        verdicts: Verdict[] = [],
        gradingMetrics: Metrics | undefined,
        infraError: string | undefined,
        cleanupWarning: string | undefined;
    const startedAt = new Date().toISOString(),
        versions: Record<string, string> = {};
    try {
        log(`${task.id} / ${modelSlug(model)} / ${arm} / ${rep}: preparing`);
        versions.task = fingerprint(join(paths.tasks, task.id));
        versions.workbench = fingerprint(join(paths.workbenches, task.workbench));
        versions.grader = fingerprint(join(paths.workbenches, 'grader'));
        await prepareFixture(paths, task, project, work);
        await startDaemon(daemon, trial, work);
        await preloadImages(paths, daemon, [
            AGENT_IMAGE,
            ENGINE_IMAGE,
            ...(task.preloadImages ?? []),
        ]);
        versions.agent_image = await docker([
            'image',
            'inspect',
            '--format',
            '{{.Id}}',
            AGENT_IMAGE,
        ]);
        versions.engine_image = await docker([
            'image',
            'inspect',
            '--format',
            '{{.Id}}',
            ENGINE_IMAGE,
        ]);
        if (task.setup) {
            const checks = stageChecks(paths, task, work),
                r = await runContainer({
                    name: 'setup',
                    daemon,
                    work,
                    cwd: project,
                    command: ['bash', '-c', checkCommand(task.setup, checks)],
                    timeoutMs: 1200000,
                });
            writeFileSync(join(out, 'setup.log'), r.stdout + r.stderr);
            if (r.code !== 0)
                throw new InfraError(`Starting fixture setup failed (exit ${r.code})`);
            await removeStaged(checks);
            await must(
                `git -C ${quote(project)} add -A && git -C ${quote(project)} -c user.name=developer -c user.email=dev@example.com commit -q --allow-empty -m 'Existing local state' && git -C ${quote(project)} tag -f baseline`
            );
        }
        await must(
            `tar -czf ${quote(join(out, 'baseline-git.tar.gz'))} -C ${quote(project)} .git`
        );
        const text = prompt(paths.tasks, task.id);
        json(join(out, 'task.json'), task);
        writeFileSync(join(out, 'prompt.md'), text);
        const product = await packageCommand(
            work,
            daemon,
            pinModel(stagePackage(paths, task.workbench, work), model),
            project,
            text
        );
        if (product.model !== model)
            throw new InfraError(`Product Workbench must use ${model} to match plain`);
        const prepared =
            arm === 'workbench'
                ? product
                : await packageCommand(
                      work,
                      daemon,
                      stagePlainControl(
                          paths,
                          work,
                          product.view.docker_engine?.mode === 'host',
                          model
                      ),
                      project,
                      text
                  );
        const command = prepared.command;
        versions.execution_protocol = 'same-engine-session-v1';
        if (arm === 'plain')
            versions.control = fingerprint(join(work, '.workbenches', 'plain-control'));
        let preparationMs = 0;
        if (!o.cold) {
            const preparing = performance.now();
            const ready = await runContainer({
                name: 'prepare',
                daemon,
                work,
                cwd: project,
                image: ENGINE_IMAGE,
                command: [...command, '--dry-run'],
                credential: true,
                timeoutMs: 1800000,
                stdoutFile: join(out, 'preparation.json'),
            });
            preparationMs = Math.round(performance.now() - preparing);
            writeFileSync(join(out, 'preparation.stderr.log'), ready.stderr);
            if (ready.code !== 0)
                throw new InfraError(
                    `Workbench preflight failed: ${ready.stderr.slice(-800)}`
                );
        }
        const events = join(out, 'events.ndjson'),
            started = performance.now();
        const r = await runContainer({
            name: 'agent',
            daemon,
            work,
            cwd: project,
            image: ENGINE_IMAGE,
            command,
            credential: true,
            timeoutMs: (task.timeoutMinutes ?? 30) * 60000,
            stdoutFile: events,
        });
        writeFileSync(join(out, 'agent.stderr.log'), r.stderr);
        metrics = {
            ...parseEvents(events, 'workbench'),
            elapsed_ms: Math.round(performance.now() - started),
            preparation_ms: preparationMs,
            timing: o.cold ? 'cold' : 'prepared',
            timed_out: r.timedOut,
            exit_code: r.code,
        };
        if (!metrics.steps && !metrics.completed && !r.timedOut)
            throw new InfraError('Agent did not start; see agent.stderr.log');
        await retainNativeTrace(work, daemon, project, events, out, 'workbench');
        await must(
            submissionArchiveCommand(
                project,
                join(out, 'submission.tar.gz'),
                task.submissionExcludes
            )
        );
        await removeTrial(trial);
        log(
            `${task.id} / ${modelSlug(model)} / ${arm} / ${rep}: grading saved submission`
        );
        mkdirSync(join(gradeWork, 'project'), { recursive: true });
        await must(
            `tar -xzf ${quote(join(out, 'submission.tar.gz'))} -C ${quote(join(gradeWork, 'project'))}`
        );
        rmSync(join(gradeWork, 'project', '.git'), { recursive: true, force: true });
        await must(
            `tar -xzf ${quote(join(out, 'baseline-git.tar.gz'))} -C ${quote(join(gradeWork, 'project'))}`
        );
        const graded = await grade(
            paths,
            task,
            trial,
            gradeWork,
            join(gradeWork, 'project'),
            join(out, 'grading')
        );
        verdicts = graded.verdicts;
        gradingMetrics = graded.metrics;
    } catch (e) {
        infraError = String(e);
        const retained = join(out, 'grading', 'metrics.json');
        if (existsSync(retained))
            gradingMetrics = JSON.parse(readFileSync(retained, 'utf8'));
    } finally {
        // A cleanup failure after grading is a warning, never a verdict: the
        // submission and its gate results are already complete. Retry once,
        // since Docker sometimes reports a removal as already in progress.
        const cleanup = async () => {
            await removeTrial(trial);
            await removeWork(work);
            await removeWork(gradeWork);
        };
        await cleanup().catch(async (first) => {
            await new Promise((r) => setTimeout(r, 5000));
            await cleanup().catch((e) => {
                cleanupWarning = `Cleanup failed: ${first}; retry: ${e}`;
                log(`${task.id} / ${arm} / ${rep}: ${cleanupWarning}`);
            });
        });
    }
    const result: TrialResult = {
        version: 1,
        trial,
        task: task.id,
        workbench: task.workbench,
        arm,
        rep,
        model,
        started_at: startedAt,
        metrics,
        verdicts,
        ...tally(verdicts),
        versions,
        ...(gradingMetrics ? { grading_metrics: gradingMetrics } : {}),
        ...(cleanupWarning ? { cleanup_warning: cleanupWarning } : {}),
        ...(infraError
            ? { infra_error: infraError, works: false, status: 'infra_error' as const }
            : {}),
    };
    json(join(out, 'result.json'), result);
    log(
        `${task.id} / ${modelSlug(model)} / ${arm} / ${rep}: ${result.status}, ${Math.round(metrics.elapsed_ms / 1000)}s, ${metrics.cost_usd === null ? 'unknown cost' : `$${metrics.cost_usd.toFixed(3)}`}`
    );
    return result;
}
export async function regrade(
    paths: Paths,
    trialDir: string,
    log: (m: string) => void
): Promise<TrialResult> {
    const previous: TrialResult = JSON.parse(
        readFileSync(join(trialDir, 'result.json'), 'utf8')
    );
    if (previous.version !== 1)
        throw new Error('Obsolete result format; historical results are excluded');
    const task = loadTask(paths.tasks, previous.task),
        owner = `trial-${crypto.randomUUID()}`,
        work = join(paths.work, `grade-${crypto.randomUUID()}`),
        project = join(work, 'project'),
        evidence = join(trialDir, `regrade-${Date.now()}`);
    mkdirSync(evidence, { recursive: true });
    mkdirSync(project, { recursive: true });
    json(join(evidence, 'previous-result.json'), previous);
    try {
        await must(
            `tar -xzf ${quote(join(trialDir, 'submission.tar.gz'))} -C ${quote(project)}`
        );
        rmSync(join(project, '.git'), { recursive: true, force: true });
        await must(
            `tar -xzf ${quote(join(trialDir, 'baseline-git.tar.gz'))} -C ${quote(project)}`
        );
        const graded = await grade(paths, task, owner, work, project, evidence),
            { infra_error: _old, error: _error, ...rest } = previous;
        const result: TrialResult = {
            ...rest,
            verdicts: graded.verdicts,
            ...tally(graded.verdicts),
            grading_metrics: graded.metrics,
            regraded_at: new Date().toISOString(),
            versions: {
                ...previous.versions,
                grader: fingerprint(join(paths.workbenches, 'grader')),
                grading_task: fingerprint(join(paths.tasks, task.id)),
            },
        };
        json(join(trialDir, 'result.json'), result);
        log(`${previous.task} / ${previous.arm}: ${result.status}`);
        return result;
    } finally {
        await removeTrial(owner).catch(() => {});
        await removeWork(work).catch(() => {});
    }
}
export async function gradeReference(
    paths: Paths,
    taskId: string,
    reference: string,
    log: (m: string) => void
): Promise<Verdict[]> {
    identifier(reference, 'reference');
    const task = loadTask(paths.tasks, taskId),
        owner = `trial-${crypto.randomUUID()}`,
        work = join(paths.work, `grade-${crypto.randomUUID()}`),
        project = join(work, 'project');
    const evidence = join(
        paths.results,
        'calibration',
        `${taskId}-${reference}-${Date.now()}`
    );
    try {
        await prepareFixture(paths, task, project, work);
        const overlay = join(paths.tasks, taskId, 'references', reference);
        if (!existsSync(overlay))
            throw new Error(`No reference ${reference} for ${taskId}`);
        cpSync(overlay, project, { recursive: true });
        const graded = await grade(paths, task, owner, work, project, evidence);
        json(join(evidence, 'summary.json'), {
            version: 1,
            task: taskId,
            reference,
            ...graded,
            ...tally(graded.verdicts),
        });
        log(`Calibration evidence: ${evidence}`);
        return graded.verdicts;
    } finally {
        await removeTrial(owner).catch(() => {});
        await removeWork(work).catch(() => {});
    }
}

/** Exercise private-daemon networking, engine compatibility, and cleanup without any model request. */
export async function runtimeSmoke(
    paths: Paths,
    names: string[],
    log: (m: string) => void
) {
    const owner = `trial-${crypto.randomUUID()}`,
        work = join(paths.work, `prepare-${crypto.randomUUID()}`),
        daemon = `wbm-${owner}-docker`;
    mkdirSync(work, { recursive: true });
    try {
        log('Starting disposable runtime smoke check');
        await startDaemon(daemon, owner, work);
        await preloadImages(paths, daemon, [AGENT_IMAGE, ENGINE_IMAGE, 'alpine:3.22']);
        const probe = await runContainer({
            name: 'probe',
            daemon,
            work,
            cwd: work,
            image: ENGINE_IMAGE,
            timeoutMs: 120000,
            command: [
                'bash',
                '-c',
                `set -e; wb --version; opencode --version; before=$(readlink /proc/self/ns/net); after=$(docker run --rm --network bridge alpine:3.22 readlink /proc/self/ns/net); test "$before" = "$after"; private=$(docker run --rm --network none alpine:3.22 readlink /proc/self/ns/net); test "$before" != "$private"; name=smoke-port-$$; trap 'docker rm -f "$name" >/dev/null 2>&1 || true' EXIT; docker run -d --name "$name" --network bridge --publish 127.0.0.1::4096 alpine:3.22 sleep 60 >/dev/null; test "$(docker port "$name" 4096/tcp)" = "127.0.0.1:4096"; printf "network policy passed\\n"`,
            ],
        });
        if (probe.code !== 0)
            throw new InfraError(
                `Runtime probe failed: ${probe.stdout}${probe.stderr}`
            );
        log(probe.stdout.trim());
        const marker = `mount-${crypto.randomUUID()}`;
        const mounted = await runContainer({
            name: 'asset-mount-probe',
            daemon,
            work,
            cwd: work,
            image: ENGINE_IMAGE,
            timeoutMs: 120000,
            command: [
                'bash',
                '-c',
                `set -eu; node -e 'require("node:fs").writeFileSync(process.env.TMPDIR + "/asset-probe", ${JSON.stringify(marker)})'; test "$(docker run --rm --network none -v "$TMPDIR/asset-probe:/asset:ro" alpine:3.22 cat /asset)" = ${quote(marker)}`,
            ],
        });
        if (mounted.code !== 0)
            throw new InfraError(
                `Nested runtime cannot read staged temporary assets: ${mounted.stdout}${mounted.stderr}`.slice(
                    0,
                    1500
                )
            );
        log('Nested temporary-asset mount passed');
        stagePlainControl(paths, work, false);
        for (const name of [...names, 'plain-control']) {
            identifier(name, 'workbench');
            const pkg = join(work, '.workbenches', name);
            if (name !== 'plain-control')
                cpSync(join(paths.workbenches, name), pkg, { recursive: true });
            const r = await runContainer({
                name: 'validate',
                daemon,
                work,
                cwd: work,
                image: ENGINE_IMAGE,
                command: ['wb', 'validate', pkg],
                timeoutMs: 120000,
            });
            if (r.code !== 0)
                throw new InfraError(`Invalid ${name}: ${r.stderr}${r.stdout}`);
            log(r.stdout.trim());
            if (name === 'plain-control') {
                const ready = await runContainer({
                    name: 'control-preflight',
                    daemon,
                    work,
                    cwd: work,
                    image: ENGINE_IMAGE,
                    timeoutMs: 1800000,
                    command: [
                        'env',
                        'OPENROUTER_API_KEY=workbenchmark-preflight-placeholder',
                        'wb',
                        'run',
                        pkg,
                        '--dir',
                        work,
                        '--task',
                        'Preflight only.',
                        '--dry-run',
                    ],
                });
                if (ready.code !== 0)
                    throw new InfraError(
                        `Plain control preflight failed: ${ready.stderr.slice(-800)}`
                    );
                log(
                    'Plain control image and credential-volume preflight passed; no model called'
                );
            }
        }
    } finally {
        await removeTrial(owner);
        await removeWork(work);
    }
    log(
        'Runtime smoke passed; no models called. Product package image builds are checked separately by wb preflight.'
    );
}
