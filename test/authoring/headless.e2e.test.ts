import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConnectionStore } from '../../src/connections/store.js';
import { OutcomeStore } from '../../src/outcomes/store.js';
import { StoredRunHandle } from '../../src/runs/handle.js';
import { RunStore } from '../../src/runs/store.js';
import type { SessionInputResult } from '../../src/sessions/control.js';
import type { SessionSnapshot } from '../../src/sessions/supervision.js';
import { workbenchHome } from '../../src/storage.js';
import { Workbench } from '../../src/workbench/workbench.js';

test.skipIf(process.env.WORKBENCH_AUTHORING_E2E !== '1')(
    'official creator authors, edits, uses, and improves a real expert through the headless CLI',
    async () => {
        const root = await realpath(await mkdtemp(join(tmpdir(), 'authoring-e2e-')));
        const home = join(root, 'home');
        const project = join(root, 'project');
        const bin = join(root, 'bin');
        await mkdir(project, { recursive: true });
        await mkdir(bin);
        const quote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;
        const executable = process.env.WORKBENCH_HEADLESS_BINARY;
        const command = (
            executable
                ? [executable]
                : [process.execPath, join(import.meta.dir, '../../src/cli.ts')]
        )
            .map(quote)
            .join(' ');
        await writeFile(join(bin, 'wb-dev'), `#!/bin/sh\nexec ${command} "$@"\n`, {
            mode: 0o700,
        });
        await writeFile(
            join(project, 'README.md'),
            '# Session lifecycle fixture\nThis small TypeScript CLI fixture owns a session state machine. Review its delivery and cleanup correctness. Do not change application code while authoring an expert.\n'
        );
        await writeFile(
            join(project, 'fixture.ts'),
            `export class Session {
    active = false;
    queue: string[] = [];
    async send(text: string) {
        this.queue.push(text);
        this.active = true;
    }
    async run(task: () => Promise<void>, cleanup: () => Promise<void>) {
        await task();
        await cleanup();
        this.active = false;
    }
}
`
        );
        const environment = Object.fromEntries(
            [
                'PATH',
                'HOME',
                'TMPDIR',
                'USER',
                'LANG',
                'TERM',
                'OPENROUTER_API_KEY',
            ].flatMap((key) => (process.env[key] ? [[key, process.env[key]]] : []))
        );
        Object.assign(environment, {
            PATH: `${bin}:${environment.PATH}`,
            WORKBENCH_HOME: home,
        });
        const preference = await new ConnectionStore(workbenchHome()).find({
            runtime: 'local',
            runner: 'opencode',
        });
        if (preference)
            await new ConnectionStore(home).save(
                { runtime: 'local', runner: 'opencode' },
                preference
            );
        const invoke = async <T = SessionSnapshot>(args: string[], stdin?: string) => {
            const child = Bun.spawn([join(bin, 'wb-dev'), ...args], {
                cwd: project,
                env: environment,
                stdin: stdin === undefined ? 'ignore' : new Blob([stdin]),
                stdout: 'pipe',
                stderr: 'pipe',
            });
            const [stdout, stderr, code] = await Promise.all([
                new Response(child.stdout).text(),
                new Response(child.stderr).text(),
                child.exited,
            ]);
            let result: T;
            try {
                result = JSON.parse(stdout);
            } catch {
                throw new Error(`CLI returned no JSON (exit ${code}): ${stderr}`);
            }
            return { code, stderr, result };
        };
        const finish = async (id: string) => {
            let after = 0;
            for (let attempt = 0; attempt < 32; attempt++) {
                const next = await invoke([
                    'wait',
                    id,
                    '--after',
                    String(after),
                    '--timeout',
                    '180',
                    '--json',
                ]);
                if (next.code === 124) continue;
                if (next.result.state === 'turn_completed') {
                    expect(next.code).toBe(0);
                    after = next.result.sequence;
                    continue;
                }
                if (next.code !== 2) {
                    expect(next.code, next.stderr + JSON.stringify(next.result)).toBe(
                        0
                    );
                    return next.result;
                }
                for (const request of next.result.pending_requests) {
                    expect(request.kind, JSON.stringify(request)).toBe('permission');
                    const answer = await invoke<SessionInputResult>([
                        'answer',
                        id,
                        request.id,
                        'allow',
                        '--json',
                    ]);
                    expect(answer.code, answer.stderr).toBe(0);
                }
            }
            throw new Error('Authoring exceeded its supervision budget');
        };
        const store = new RunStore(home);
        try {
            const created = await invoke<SessionInputResult>([
                'create',
                'lifecycle',
                '--task',
                'Create a compact, useful session lifecycle review expert for this fixture repository. Its expertise is asynchronous delivery, active-turn rejection versus explicit queuing, and cleanup on failures. Use local runtime, OpenCode harness, canonical model openai/gpt-5.4-mini routed through openrouter, and shell tools. It should inspect explicitly requested source files, report concrete correctness findings with severity and file/line evidence, and return a Markdown report when asked. Do not fix application code or add unrelated docs. Keep the package minimal and only modify .workbenches/lifecycle. No questions are needed; this brief is complete.',
                '--detach',
                '--json',
            ]);
            expect(created.code, created.stderr).toBe(0);
            expect((await finish(created.result.session_id)).authoring?.status).toBe(
                'completed'
            );
            const packagePath = join(project, '.workbenches', 'lifecycle');
            const original = await Workbench.load(packagePath);
            const brief = join(root, 'edit.txt');
            await writeFile(
                brief,
                'Improve this expert with a rule to distinguish expected active-send rejection from silently queued input, and never call a cleanup path verified without a failure-path check. Preserve the model, harness, runtime, tools, and scope. Increment the version. Only modify .workbenches/lifecycle. No questions are needed.'
            );
            const edited = await invoke<SessionInputResult>([
                'create',
                'lifecycle',
                '--task-file',
                brief,
                '--detach',
                '--json',
            ]);
            expect(edited.code, edited.stderr).toBe(0);
            expect((await finish(edited.result.session_id)).authoring?.status).toBe(
                'completed'
            );
            expect((await Workbench.load(packagePath)).manifest.version).not.toBe(
                original.manifest.version
            );
            const launched = await invoke<SessionInputResult>([
                'run',
                packagePath,
                '--connection',
                'openrouter',
                '--task',
                'Review only fixture.ts for delivery and failure cleanup correctness. Return findings.md with concrete severity and line-number evidence. Do not modify application files. Keep the response concise.',
                '--detach',
                '--json',
            ]);
            expect(launched.code, launched.stderr).toBe(0);
            const audit = await finish(launched.result.session_id);
            if (!audit.outcome_id) throw new Error('Audit returned no outcome');
            const outcomes = new OutcomeStore(home);
            const outcome = await outcomes.read(audit.outcome_id);
            const artifact = outcome.artifacts.find(
                (entry) => entry.name === 'findings.md'
            );
            if (!artifact)
                throw new Error(`Audit returned no requested report: ${audit.final}`);
            const report = await readFile(
                await outcomes.artifactPath(outcome.id, artifact.id),
                'utf8'
            );
            expect(report).toContain('fixture.ts');
            expect(report.toLowerCase()).toContain('cleanup');
            const beforeImprovement = (await Workbench.load(packagePath)).manifest
                .version;
            const improved = await invoke<SessionInputResult>(
                [
                    'create',
                    '--from',
                    launched.result.session_id,
                    '--stdin',
                    '--detach',
                    '--json',
                ],
                'Improve the expert using the actual audit evidence. Add a precise requirement to separately assess successful cleanup and cleanup when task throws, and to cite actual source lines rather than infer behavior from method names. Requested reports are user deliverables: follow the injected runtime delivery contract, not a hardcoded path or project source file, without requiring the user to mention an outbox. Preserve its scope, model, runtime, and harness; bump the version. Only modify its package. No questions are needed.'
            );
            expect(improved.code, improved.stderr).toBe(0);
            const verified = await finish(improved.result.session_id);
            expect(verified.authoring?.status).toBe('completed');
            expect(verified.authoring?.result?.evidence_path).toBeDefined();
            expect((await Workbench.load(packagePath)).manifest.version).not.toBe(
                beforeImprovement
            );
            const reused = await invoke<SessionInputResult>([
                'run',
                packagePath,
                '--connection',
                'openrouter',
                '--task',
                'Review only fixture.ts again. Separately assess successful task cleanup, task rejection cleanup, and cleanup rejection state reset. Return improved.md with actual source line evidence and distinguish source inspection from exercised checks. Do not modify application files.',
                '--detach',
                '--json',
            ]);
            expect(reused.code, reused.stderr).toBe(0);
            const improvedAudit = await finish(reused.result.session_id);
            if (!improvedAudit.outcome_id)
                throw new Error('Improved expert returned no outcome');
            const improvedOutcome = await outcomes.read(improvedAudit.outcome_id);
            const improvedReport = improvedOutcome.artifacts.find(
                (entry) => entry.name === 'improved.md'
            );
            if (!improvedReport)
                throw new Error(
                    `Improved expert returned no report: ${improvedAudit.final}`
                );
            const improvedText = await readFile(
                await outcomes.artifactPath(improvedOutcome.id, improvedReport.id),
                'utf8'
            );
            expect(improvedText).toContain('fixture.ts');
            expect(improvedText.toLowerCase()).toContain('cleanup');
            expect(await readFile(join(project, 'fixture.ts'), 'utf8')).toContain(
                'await task();\n        await cleanup();'
            );
        } finally {
            for (const run of await store.list())
                if (!RunStore.isTerminal(run.status)) {
                    const handle = new StoredRunHandle(home, run.id);
                    await handle.cancel('Authoring fixture cleanup').catch(() => {});
                    await Promise.race([
                        handle.result.catch(() => {}),
                        Bun.sleep(10_000),
                    ]);
                }
            if (process.env.WORKBENCH_HEADLESS_KEEP === '1')
                console.error(`Authoring fixture retained at ${root}`);
            else await rm(root, { recursive: true, force: true });
        }
    },
    20 * 60 * 1000
);
