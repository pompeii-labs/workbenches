#!/usr/bin/env bun
import {
    copyFileSync,
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { retainCampaignSource } from './lib/campaign-source.ts';
import { monitorCampaign } from './lib/monitor.ts';
import {
    rememberRemote,
    runRemote,
    savedRemote,
    validateRemote,
} from './lib/remote.ts';
import {
    loadResults,
    mergeCampaigns,
    writeReport,
    writeReportFiles,
} from './lib/report.ts';
import { docker, exec, type Paths } from './lib/runtime.ts';
import {
    type Arm,
    identifier,
    listTasks,
    loadTask,
    modelSlug,
    trialName,
} from './lib/spec.ts';
import {
    AGENT_IMAGE,
    DEFAULT_MODEL,
    ENGINE_IMAGE,
    fingerprint,
    gradeReference,
    regrade,
    runTrial,
    runtimeSmoke,
} from './lib/trial.ts';

const bench = dirname(Bun.fileURLToPath(import.meta.url));
const runtimeAssets = join(bench, 'lib', 'runtime-assets');
function printReport(directory: string) {
    writeReport(directory);
    console.log(readFileSync(join(directory, 'matrix.md'), 'utf8'));
}
export function positiveInteger(value: string, label: string) {
    if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value)))
        throw new Error(`${label} must be a positive integer`);
    return Number(value);
}
export function parseArms(value: string): Arm[] {
    const arms = value.split(',');
    if (
        !arms.length ||
        new Set(arms).size !== arms.length ||
        arms.some((a) => !['plain', 'workbench'].includes(a))
    )
        throw new Error('--arms must select plain, workbench, or plain,workbench');
    return arms as Arm[];
}
export function parseModels(value: string): string[] {
    const models = value.split(',');
    if (new Set(models.map(modelSlug)).size !== models.length)
        throw new Error('--models must name distinct models');
    return models;
}
const help = `workbenchmark: compare the same request with and without a Workbench.

  list                                    list available tasks
  check [--tasks all] [--wb path]          validate tasks; optionally validate packages with wb
  images --wb <Linux wb binary>           build the generic agent and engine launcher
  smoke                                   check private runtime and packages, no model calls
  run [--tasks all] [--reps 3] [--parallel 2] [--campaign name] [--cold]
  report --campaign name                  print summary and write matrix.json / matrix.md
  report --campaigns a,b,c [--out name]   merge campaigns cell-by-cell (last one wins per cell)
  monitor --campaign name [--once] [--json]  watch actor/grader progress; read-only
  regrade --campaign name [--tasks a,b]    re-run the gates on saved submissions
  calibrate [--tasks a,b] [--reference name]  grade every reference solution (or one)

Options: --arms plain,workbench --models vendor/a,vendor/b --tasks-dir --workbenches-dir --results-dir
         --work-dir --image-cache --out --help
Remote: --ssh ALIAS --remote-dir /absolute/benchmark/path
        Campaign SSH targets are remembered locally; monitor needs only --campaign.
        Remote execution uses the installed host source. --results-dir is local routing storage.

run, regrade, and calibrate need Linux Docker with privileged container
support and OPENROUTER_API_KEY in the environment: only run calls a model,
but the engine checks the key when it prepares a runtime. Workbenches own
their Dockerfiles.
Old results are excluded. Campaigns never overwrite existing attempts.`;

export async function main(args = process.argv.slice(2)) {
    const { positionals, values } = parseArgs({
        args,
        allowPositionals: true,
        options: {
            tasks: { type: 'string', default: 'all' },
            arms: { type: 'string', default: 'plain,workbench' },
            models: { type: 'string', default: DEFAULT_MODEL },
            reps: { type: 'string', default: '3' },
            parallel: { type: 'string', default: '2' },
            campaign: { type: 'string' },
            campaigns: { type: 'string' },
            out: { type: 'string' },
            reference: { type: 'string' },
            'tasks-dir': { type: 'string' },
            'workbenches-dir': { type: 'string' },
            'results-dir': { type: 'string' },
            'work-dir': { type: 'string' },
            'image-cache': { type: 'string' },
            wb: { type: 'string' },
            cold: { type: 'boolean', default: false },
            help: { type: 'boolean', default: false },
            once: { type: 'boolean', default: false },
            json: { type: 'boolean', default: false },
            ssh: { type: 'string' },
            'remote-dir': { type: 'string' },
        },
    });
    const command = positionals[0];
    if (values.help || !command) {
        console.log(help);
        return;
    }
    if (
        positionals.length !== 1 ||
        ![
            'list',
            'check',
            'images',
            'smoke',
            'run',
            'report',
            'monitor',
            'regrade',
            'calibrate',
        ].includes(command)
    )
        throw new Error(`Unknown command: ${positionals.join(' ')}. Use --help.`);
    const localResults = resolve(values['results-dir'] ?? join(bench, 'results'));
    const saved = values.campaign
        ? savedRemote(localResults, values.campaign)
        : undefined;
    if (values.ssh || saved) {
        if (!values.campaign)
            throw new Error('--campaign is required for remote execution');
        if (!['run', 'monitor', 'report', 'regrade'].includes(command))
            throw new Error(
                'Remote routing supports run, monitor, report, and regrade'
            );
        const target = validateRemote({
            ssh: values.ssh ?? saved!.ssh,
            directory: values['remote-dir'] ?? saved?.directory ?? '',
        });
        rememberRemote(localResults, values.campaign, target);
        await runRemote(target, args, {
            monitor: command === 'monitor',
            json: values.json,
            once: values.once,
        });
        return;
    }
    if (values['remote-dir'])
        throw new Error('--remote-dir requires --ssh or a saved campaign target');
    const paths: Paths = {
        bench,
        tasks: resolve(values['tasks-dir'] ?? join(bench, 'tasks')),
        workbenches: resolve(values['workbenches-dir'] ?? join(bench, '.workbenches')),
        results: resolve(values['results-dir'] ?? join(bench, 'results')),
        work: resolve(values['work-dir'] ?? join(bench, '.work')),
        imageCache: resolve(values['image-cache'] ?? join(bench, '.image-cache')),
    };
    const campaignDir = () => {
        if (!values.campaign) throw new Error('--campaign is required');
        identifier(values.campaign, 'campaign');
        return join(paths.results, values.campaign);
    };
    const log = (message: string) => console.error(message);
    if (command === 'monitor') {
        await monitorCampaign(campaignDir(), { once: values.once, json: values.json });
        return;
    }
    if (command === 'report') {
        if (values.campaign && values.campaigns)
            throw new Error('Use either --campaign or --campaigns, not both');
        if (values.campaigns) {
            const names = values.campaigns.split(',');
            if (!names.length)
                throw new Error('--campaigns must list at least one campaign');
            for (const name of names) identifier(name, 'campaign');
            const perCampaign = names.map((name) => ({
                name,
                results: loadResults(join(paths.results, name)),
            }));
            const { results, sources } = mergeCampaigns(perCampaign);
            const out = values.out ?? names.join('+');
            if (!/^[A-Za-z0-9][A-Za-z0-9_.+-]{0,159}$/.test(out))
                throw new Error(
                    '--out must be a short identifier (letters, digits, _, -, ., +)'
                );
            const dir = join(paths.results, out);
            writeReportFiles(dir, results, { sources, campaigns: names });
            console.log(readFileSync(join(dir, 'matrix.md'), 'utf8'));
            for (const s of sources)
                console.log(
                    `${s.task} / ${s.model} / ${s.arm}: ${s.campaign} (${s.attempts} attempts)`
                );
            console.log(`Results: ${dir}`);
            return;
        }
        const dir = campaignDir();
        printReport(dir);
        return;
    }
    const ids =
        values.tasks === 'all' ? listTasks(paths.tasks) : values.tasks!.split(',');
    if (new Set(ids).size !== ids.length) throw new Error('Duplicate task selection');
    const tasks = ids
        .map((id) => loadTask(paths.tasks, id))
        .filter((t) => values.tasks !== 'all' || !t.retired);
    if (!tasks.length) throw new Error('No tasks selected');
    const packages = [...new Set([...tasks.map((t) => t.workbench), 'grader'])];
    for (const name of packages)
        if (!existsSync(join(paths.workbenches, name, 'workbench.yml')))
            throw new Error(`Missing Workbench: ${name}`);
    if (command === 'list') {
        console.table(
            tasks.map((t) => ({
                task: t.id,
                workbench: t.workbench,
                checks: t.gates?.length ?? 0,
                criteria: t.criteria?.length ?? 0,
            }))
        );
        return;
    }
    if (command === 'check') {
        for (const task of tasks) {
            fingerprint(join(paths.tasks, task.id));
            if (existsSync(join(paths.tasks, task.id, 'Dockerfile')))
                throw new Error(
                    `${task.id}: put runtime Dockerfiles in Workbench packages`
                );
        }
        for (const name of packages) {
            fingerprint(join(paths.workbenches, name));
            if (values.wb) {
                const r = await exec([
                    resolve(values.wb),
                    'validate',
                    join(paths.workbenches, name),
                ]);
                if (r.code !== 0) throw new Error(`${name}: ${r.stderr || r.stdout}`);
            }
        }
        console.log(
            `Valid: ${tasks.length} tasks, ${packages.length} Workbench packages. ${values.wb ? 'Engine manifest validation passed.' : 'Use --wb to also validate manifests with the current engine.'}`
        );
        return;
    }
    if (command === 'images') {
        if (!values.wb)
            throw new Error(
                '--wb must point to a current Linux amd64 Workbench binary'
            );
        const binary = resolve(values.wb);
        if (!existsSync(binary)) throw new Error(`Missing binary: ${binary}`);
        const header = readFileSync(binary).subarray(0, 20);
        if (
            header.toString('hex', 0, 4) !== '7f454c46' ||
            header.readUInt16LE(18) !== 62
        )
            throw new Error('--wb must be a Linux amd64 ELF binary');
        copyFileSync(binary, join(runtimeAssets, 'wb'));
        for (const [tag, file] of [
            [AGENT_IMAGE, 'agent.Dockerfile'],
            [ENGINE_IMAGE, 'wb.Dockerfile'],
        ]) {
            log(`Building ${tag}`);
            const r = await exec(
                [
                    'docker',
                    'build',
                    '--platform',
                    'linux/amd64',
                    '-t',
                    tag!,
                    '-f',
                    join(runtimeAssets, file!),
                    runtimeAssets,
                ],
                { timeoutMs: 1800000 }
            );
            if (r.code !== 0)
                throw new Error(`Image build failed: ${r.stderr.slice(-3000)}`);
        }
        console.log(
            'Generic agent and engine launcher built. Each Workbench prepares its own runtime through wb.'
        );
        return;
    }
    if (command === 'smoke') {
        await runtimeSmoke(paths, packages, log);
        return;
    }
    const parallel = positiveInteger(values.parallel!, '--parallel'),
        reps = positiveInteger(values.reps!, '--reps'),
        arms = parseArms(values.arms!),
        models = parseModels(values.models!);
    if (parallel > 32) throw new Error('--parallel must be at most 32');
    // Only run calls a model, but the engine's dry-run preflight (used to
    // prepare the grading runtime for every command) refuses to start
    // without the key present, so fail early and clearly here.
    if (!process.env.OPENROUTER_API_KEY)
        throw new Error(
            'Set OPENROUTER_API_KEY (the engine checks it even when no model is called)'
        );
    await docker(['info']);
    await docker(['image', 'inspect', AGENT_IMAGE, ENGINE_IMAGE]);
    mkdirSync(paths.work, { recursive: true });
    if (command === 'run') {
        const campaign = values.campaign ?? `campaign-${Date.now()}`;
        identifier(campaign, 'campaign');
        const dir = join(paths.results, campaign);
        // A fresh campaign is a deliberate boundary. No legacy data or retries are silently reused.
        mkdirSync(paths.results, { recursive: true });
        mkdirSync(dir);
        writeFileSync(
            join(dir, 'campaign.json'),
            JSON.stringify(
                {
                    version: 1,
                    campaign,
                    tasks: tasks.map((t) => ({
                        id: t.id,
                        sha256: fingerprint(join(paths.tasks, t.id)),
                    })),
                    arms,
                    models,
                    reps,
                    parallel,
                    timing: values.cold ? 'cold' : 'prepared',
                    created_at: new Date().toISOString(),
                },
                null,
                2
            )
        );
        retainCampaignSource(paths, tasks, dir);
        const queue = Array.from({ length: reps }, (_, i) =>
            tasks.flatMap((task, index) =>
                models.flatMap((model) =>
                    ((i + index) % 2 ? [...arms].reverse() : arms).map((arm) => ({
                        task,
                        arm,
                        model,
                        rep: i + 1,
                    }))
                )
            )
        ).flat();
        log(`${queue.length} attempts queued in ${dir}`);
        try {
            await Promise.all(
                Array.from({ length: Math.min(parallel, queue.length) }, async () => {
                    for (let next = queue.shift(); next; next = queue.shift())
                        await runTrial({
                            paths,
                            ...next,
                            campaign,
                            cold: values.cold,
                            log,
                        });
                })
            );
        } finally {
            printReport(dir);
            console.log(`Results: ${dir}`);
        }
    } else if (command === 'regrade') {
        const dir = campaignDir(),
            results = loadResults(dir),
            wanted = new Set(tasks.map((t) => t.id));
        const queue = results
            .filter((r) => wanted.has(r.task))
            .map((r) => join(dir, 'trials', trialName(r.task, r.model, r.arm, r.rep)));
        try {
            await Promise.all(
                Array.from({ length: Math.min(parallel, queue.length) }, async () => {
                    for (let path = queue.shift(); path; path = queue.shift())
                        if (existsSync(join(path, 'submission.tar.gz')))
                            await regrade(paths, path, log);
                })
            );
        } finally {
            printReport(dir);
        }
    } else {
        for (const task of tasks) {
            const dir = join(paths.tasks, task.id, 'references');
            if (!existsSync(dir)) {
                log(`${task.id}: no references`);
                continue;
            }
            // A reference that needs building (Godot) is committed as source;
            // scripts/build-godot-references.sh writes <name>-built beside it,
            // and the built copy is the one that gets graded.
            const names = readdirSync(dir, { withFileTypes: true })
                .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
                .map((entry) => entry.name);
            const references = names.filter(
                (name) => name.endsWith('-built') || !names.includes(`${name}-built`)
            );
            for (const reference of values.reference
                ? [values.reference]
                : references) {
                const verdicts = await gradeReference(paths, task.id, reference, log);
                console.log(`\n${task.id} / ${reference}`);
                console.table(
                    verdicts.map((v) => ({ id: v.id, status: v.status, kind: v.kind }))
                );
            }
        }
    }
}
if (import.meta.main)
    main().catch((error) => {
        console.error(`workbenchmark: ${error.message}`);
        process.exitCode = 1;
    });
