import { afterEach, describe, expect, test } from 'bun:test';
import {
    chmod,
    lstat,
    mkdir,
    mkdtemp,
    readFile,
    realpath,
    rm,
    stat,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { OutcomeStore, type RunOutcome } from '../src/outcomes/index.js';
import { processIsAlive } from '../src/outcomes/lease.js';
import { isOutboxPermission } from '../src/runners/opencode/outbox-permission.js';
import {
    InteractiveRun,
    RunDispatcher,
    RunStore,
    type WorkbenchEvent,
} from '../src/runs/index.js';
import { E2BSdkClient } from '../src/runtimes/e2b/sdk.js';
import { WorkbenchResolver } from '../src/workbench/index.js';
import { seedModelCatalogFixture } from './model-catalog-fixture.js';

const enabled = process.env.WORKBENCH_OUTCOME_HARNESS_E2E === '1';
const testModel = process.env.WORKBENCH_OUTCOME_MODEL ?? 'anthropic/claude-sonnet-4-5';
const selectedRuntimes = (
    process.env.WORKBENCH_OUTCOME_RUNTIMES ?? 'local,docker,e2b'
).split(',');
const cli = join(import.meta.dir, '..', 'src', 'cli.ts');
const directories: string[] = [];
const homes: Array<{ path: string; runtime: string }> = [];

afterEach(async () => {
    for (const home of homes.splice(0)) {
        const runs = await new RunStore(home.path).list();
        for (const run of runs) {
            if (RunStore.isTerminal(run.status)) continue;
            const cancellation = new RunDispatcher(home.path)
                .handle(run.id)
                .cancel('Harness outcomes test cleanup')
                .catch(() => {});
            await Promise.race([cancellation, Bun.sleep(2_000)]);
            if (run.pid && processIsAlive(run.pid)) {
                // Dispatcher workers own detached process groups. Stop only
                // this fresh fixture's group, including a blocked image pull.
                signalFixtureGroup(run.pid, 'SIGTERM');
                for (
                    let attempt = 0;
                    attempt < 20 && processIsAlive(run.pid);
                    attempt++
                ) {
                    await Bun.sleep(50);
                }
                if (processIsAlive(run.pid)) {
                    signalFixtureGroup(run.pid, 'SIGKILL');
                    for (
                        let attempt = 0;
                        attempt < 20 && processIsAlive(run.pid);
                        attempt++
                    ) {
                        await Bun.sleep(50);
                    }
                }
                if (processIsAlive(run.pid))
                    throw new Error('Fixture worker did not exit during cleanup');
            }
        }
        if (home.runtime === 'e2b' && process.env.E2B_API_KEY) {
            const client = new E2BSdkClient(process.env.E2B_API_KEY);
            for (const sandbox of await client.listManaged(RunStore.scope(home.path))) {
                await client.killSandbox(sandbox.id);
            }
        }
    }
    await Promise.all(
        directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
    );
});

function signalFixtureGroup(pid: number, signal: NodeJS.Signals): void {
    try {
        process.kill(-pid, signal);
    } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return;
        throw error;
    }
}

describe.skipIf(!enabled)('Real harness outcomes across runtimes', () => {
    for (const runtime of ['local', 'docker', 'e2b'] as const) {
        for (const runner of ['opencode', 'pi'] as const) {
            test.skipIf(!selectedRuntimes.includes(runtime))(
                `${runner} on ${runtime} publishes live revisions while the native session remains open`,
                async () => {
                    if (!process.env.OPENROUTER_API_KEY)
                        throw new Error('OPENROUTER_API_KEY is required');
                    if (runtime === 'e2b' && !process.env.E2B_API_KEY)
                        throw new Error('E2B_API_KEY is required');
                    const fixture = await createFixture(runtime, runner);
                    const env = testEnvironment(fixture.home, true, runtime === 'e2b');
                    const resolved = await new WorkbenchResolver().resolve(
                        fixture.packageDirectory,
                        { cwd: fixture.root, home: fixture.home }
                    );
                    const events: WorkbenchEvent[] = [];
                    const session = await InteractiveRun.start({
                        resolved,
                        home: fixture.home,
                        interactive: true,
                        connection: 'openrouter',
                        workspaces: [
                            {
                                name: 'notes',
                                path: fixture.notes,
                                access: 'read-write',
                            },
                        ],
                        dependencies: { env },
                        onPermission: ({ action, resources }) =>
                            isOutboxPermission(
                                action,
                                resources,
                                runtime === 'local'
                                    ? fixture.notes
                                    : '/workspaces/notes'
                            )
                                ? 'allow_once'
                                : 'reject',
                        onEvent: (event) => void events.push(event),
                    });
                    const store = new OutcomeStore(fixture.home);
                    try {
                        await session.send(
                            'Remember the codeword saffron. Use your existing tools to return live-report.txt containing exactly first-version followed by a newline. Also change modify.txt in the workspace to live edit followed by a newline. Finish with one short sentence.'
                        );
                        expect(
                            events.some((event) => event.type === 'outcome.failed'),
                            JSON.stringify(
                                events.filter(
                                    (event) => event.type === 'outcome.failed'
                                )
                            )
                        ).toBeFalse();
                        expect(
                            events.some(
                                (event) =>
                                    event.type.startsWith('run.') &&
                                    [
                                        'run.completed',
                                        'run.failed',
                                        'run.cancelled',
                                    ].includes(event.type)
                            )
                        ).toBeFalse();
                        const first = (await store.listByRun(session.runId))[0];
                        const artifact = first?.artifacts.find(
                            (value) => value.name === 'live-report.txt'
                        );
                        if (!first || !artifact)
                            throw new Error(
                                `Missing live artifact before session close: ${JSON.stringify({ artifacts: first?.artifacts.map((value) => value.name), text: events.filter((event) => event.type === 'output.text').map((event) => Reflect.get(event.data as object, 'text')) })}`
                            );
                        expect(first.turn_index).toBe(1);
                        expect(first.changesets).toEqual([]);
                        expect((await store.receipt(first.id)).state).toBe('present');
                        const originalPath = await store.artifactPath(
                            first.id,
                            artifact.id
                        );
                        expect(await readFile(originalPath, 'utf8')).toBe(
                            'first-version\n'
                        );
                        expect(
                            events.findIndex(
                                (event) => event.type === 'outcome.available'
                            )
                        ).toBeLessThan(
                            events.findIndex((event) => event.type === 'turn.completed')
                        );
                        const nativeId = session.runnerSessionId;
                        await session.send(
                            'Revise live-report.txt in your CURRENT outbox so it contains exactly second-version followed by a newline. Do not read or edit retained artifacts. Tell me the codeword you remember in one short sentence.'
                        );
                        expect(session.runnerSessionId).toBe(nativeId);
                        const revisions = await store.listByRun(session.runId);
                        const second = revisions[0];
                        const revised = second?.artifacts.find(
                            (value) => value.name === 'live-report.txt'
                        );
                        if (!second || !revised)
                            throw new Error('Missing live revision');
                        expect(revisions).toHaveLength(2);
                        expect(second.turn_index).toBe(2);
                        expect(second.id).not.toBe(first.id);
                        const revisedPath = await store.artifactPath(
                            second.id,
                            revised.id
                        );
                        expect(await readFile(revisedPath, 'utf8')).toBe(
                            'second-version\n'
                        );
                        expect(await readFile(originalPath, 'utf8')).toBe(
                            'first-version\n'
                        );
                        const text = events
                            .filter((event) => event.type === 'output.text')
                            .map((event) =>
                                String(Reflect.get(event.data as object, 'text') ?? '')
                            )
                            .join('');
                        expect(text.toLowerCase()).toContain('saffron');
                        await session.send(
                            'Reply with just ready. Do not use tools or change any files.'
                        );
                        expect(
                            events.filter((event) => event.type === 'outcome.available')
                        ).toHaveLength(2);
                        expect(
                            await store.findFinalByRun(session.runId)
                        ).toBeUndefined();
                        await session.close();
                        const final = await store.findFinalByRun(session.runId);
                        expect(final?.completeness).toBe('complete');
                        expect(
                            final?.changesets[0]?.entries.some(
                                (entry) => entry.path === 'modify.txt'
                            )
                        ).toBeTrue();
                        expect(await readFile(originalPath, 'utf8')).toBe(
                            'first-version\n'
                        );
                        expect(await readFile(revisedPath, 'utf8')).toBe(
                            'second-version\n'
                        );
                        expect(
                            await lstat(
                                join(fixture.home, 'runs', session.runId, 'outbox')
                            ).catch(() => undefined)
                        ).toBeUndefined();
                        if (runtime === 'e2b') {
                            expect(
                                await new E2BSdkClient(
                                    process.env.E2B_API_KEY as string
                                ).listManaged(RunStore.scope(fixture.home))
                            ).toEqual([]);
                            expect(
                                await readFile(join(fixture.root, 'modify.txt'), 'utf8')
                            ).toBe('before\n');
                        }
                    } finally {
                        await session.close().catch(() => {});
                        await resolved.cleanup();
                    }
                },
                10 * 60 * 1_000
            );
            test.skipIf(!selectedRuntimes.includes(runtime))(
                `${runner} on ${runtime} learns the outbox from engine instructions and refreshes it on resume`,
                async () => {
                    if (!process.env.OPENROUTER_API_KEY)
                        throw new Error('OPENROUTER_API_KEY is required');
                    if (runtime === 'e2b' && !process.env.E2B_API_KEY)
                        throw new Error('E2B_API_KEY is required');
                    const observeContext = runner === 'opencode' && runtime === 'local';
                    const fixture = await createFixture(
                        runtime,
                        runner,
                        observeContext
                    );
                    const env = testEnvironment(fixture.home, true, runtime === 'e2b');
                    const result = await command(fixture.root, env, [
                        'run',
                        fixture.packageDirectory,
                        '--workspace',
                        `notes=${fixture.notes}`,
                        '--connection',
                        'openrouter',
                        '--task',
                        'Remember the codeword violet. Use your existing tools to return a file named context-report.txt containing exactly first-report followed by a newline. Return the supplied reference https://example.com/report as a link alongside the file. Do not inspect environment variables or read output-protocol documentation. Finish with one short sentence.',
                        '--json',
                    ]);
                    expect(result.code, result.stderr).toBe(0);
                    const events = parseEvents(result.stdout);
                    const runId = events[0]?.run_id;
                    if (!runId) throw new Error('Run identity missing');
                    const run = await new RunStore(fixture.home).read(runId);
                    if (!run.outcome_id || !run.session_id)
                        throw new Error('Outcome or session identity missing');
                    const store = new OutcomeStore(fixture.home);
                    const first = await store.read(run.outcome_id);
                    const initialContext = observeContext
                        ? await observedContext(store, first)
                        : undefined;
                    const artifact = first.artifacts.find(
                        (artifact) => artifact.name === 'context-report.txt'
                    );
                    if (!artifact)
                        throw new Error(
                            'Agent did not return the report through its outbox'
                        );
                    expect(
                        await readFile(await store.blob(artifact.content), 'utf8')
                    ).toBe('first-report\n');
                    expect(
                        first.links.some(
                            (link) => link.uri === 'https://example.com/report'
                        ),
                        deliveryDiagnostic(events)
                    ).toBeTrue();
                    expect(first.changesets).toEqual([]);
                    expect(
                        await lstat(join(fixture.root, 'context-report.txt')).catch(
                            () => undefined
                        )
                    ).toBeUndefined();
                    const resumed = await command(fixture.root, env, [
                        'resume',
                        run.session_id,
                        '--task',
                        'Send me a new context-report.txt containing only the codeword you remember followed by a newline. Do not modify my project files. Finish with one short sentence.',
                        '--json',
                    ]);
                    expect(resumed.code, resumed.stderr).toBe(0);
                    const resumedRunId = parseEvents(resumed.stdout)[0]?.run_id;
                    if (!resumedRunId) throw new Error('Resumed run identity missing');
                    const resumedRun = await new RunStore(fixture.home).read(
                        resumedRunId
                    );
                    if (!resumedRun.outcome_id)
                        throw new Error('Resumed outcome identity missing');
                    const second = await store.read(resumedRun.outcome_id);
                    const resumedContext = observeContext
                        ? await observedContext(store, second)
                        : undefined;
                    if (initialContext && resumedContext && runtime === 'local') {
                        const oldOutbox = initialContext.match(
                            /<outbox[^>]*path="([^"]+)"/
                        )?.[1];
                        if (!oldOutbox)
                            throw new Error('Observed initial outbox missing');
                        expect(resumedContext).not.toContain(oldOutbox);
                    }
                    const returned = second.artifacts.find(
                        (artifact) => artifact.name === 'context-report.txt'
                    );
                    if (!returned)
                        throw new Error(
                            `Resumed agent did not return a report through its fresh outbox: ${deliveryDiagnostic(parseEvents(resumed.stdout))}`
                        );
                    expect(
                        await readFile(await store.blob(returned.content), 'utf8')
                    ).toBe('violet\n');
                    expect(second.id).not.toBe(first.id);
                    expect(second.changesets).toEqual([]);
                    expect(await store.read(first.id)).toEqual(first);
                    expect(
                        await readFile(await store.blob(artifact.content), 'utf8')
                    ).toBe('first-report\n');
                },
                10 * 60 * 1_000
            );
            test.skipIf(!selectedRuntimes.includes(runtime))(
                `${runner} on ${runtime} revises a prior HTML deliverable after resume and preserves its supporting assets`,
                async () => {
                    if (!process.env.OPENROUTER_API_KEY)
                        throw new Error('OPENROUTER_API_KEY is required');
                    if (runtime === 'e2b' && !process.env.E2B_API_KEY)
                        throw new Error('E2B_API_KEY is required');
                    const fixture = await createFixture(runtime, runner);
                    const env = testEnvironment(fixture.home, true, runtime === 'e2b');
                    const result = await command(fixture.root, env, [
                        'run',
                        fixture.packageDirectory,
                        '--workspace',
                        `notes=${fixture.notes}`,
                        '--connection',
                        'openrouter',
                        '--task',
                        'Use ./deliverable-probe.sh to produce my HTML report and its logo and stylesheet. Return those files. Do not modify project files. Finish with one short sentence.',
                        '--json',
                    ]);
                    expect(result.code, result.stderr).toBe(0);
                    const runId = parseEvents(result.stdout)[0]?.run_id;
                    if (!runId) throw new Error('Initial run missing');
                    const initialRun = await new RunStore(fixture.home).read(runId);
                    if (!initialRun.outcome_id || !initialRun.session_id)
                        throw new Error('Initial result or session missing');
                    const store = new OutcomeStore(fixture.home);
                    const original = await store.read(initialRun.outcome_id);
                    const report = original.artifacts.find(
                        (file) => file.path === 'reports/report.html'
                    );
                    if (!report)
                        throw new Error(
                            `Initial report missing: ${deliveryDiagnostic(parseEvents(result.stdout))}`
                        );
                    const opened = await store.artifactPath(original.id, report.id);
                    const originalHtml = await readFile(opened, 'utf8');
                    expect(originalHtml).toContain(fixture.reportMarker);
                    expect(
                        await readFile(
                            join(opened, '..', '..', 'assets', 'logo.svg'),
                            'utf8'
                        )
                    ).toBe(fixture.reportLogo);
                    const resumed = await command(fixture.root, env, [
                        'resume',
                        initialRun.session_id,
                        '--task',
                        'Update my report heading to VERSION TWO and add a second checklist item. Keep the existing content, logo and styling. Do not modify my project files. Finish with one short sentence.',
                        '--json',
                    ]);
                    expect(resumed.code, resumed.stderr).toBe(0);
                    const secondId = parseEvents(resumed.stdout)[0]?.run_id;
                    if (!secondId) throw new Error('Resumed run missing');
                    const secondRun = await new RunStore(fixture.home).read(secondId);
                    if (!secondRun.outcome_id)
                        throw new Error('Resumed outcome missing');
                    const second = await store.read(secondRun.outcome_id);
                    const revised = second.artifacts.find(
                        (file) => file.path === 'reports/report.html'
                    );
                    if (!revised)
                        throw new Error(
                            `Revised report missing: ${deliveryDiagnostic(parseEvents(resumed.stdout))}`
                        );
                    const newPath = await store.artifactPath(second.id, revised.id);
                    const newHtml = await readFile(newPath, 'utf8');
                    expect(newHtml).toContain('VERSION TWO');
                    expect(newHtml).toContain(fixture.reportMarker);
                    expect(newHtml).toContain('../assets/logo.svg');
                    expect(newHtml).toContain('../assets/report.css');
                    expect(newHtml.match(/<li\b/g)?.length ?? 0).toBeGreaterThanOrEqual(
                        2
                    );
                    expect(
                        await readFile(
                            join(newPath, '..', '..', 'assets', 'logo.svg'),
                            'utf8'
                        )
                    ).toBe(fixture.reportLogo);
                    expect(
                        await readFile(
                            join(newPath, '..', '..', 'assets', 'report.css'),
                            'utf8'
                        )
                    ).toBe('body { color: purple; }\n');
                    expect(await readFile(opened, 'utf8')).toBe(originalHtml);
                    expect(
                        await readFile(await store.blob(report.content), 'utf8')
                    ).toBe(originalHtml);
                    expect(second.changesets).toEqual([]);
                    expect(await store.read(original.id)).toEqual(original);
                    expect(
                        await lstat(join(fixture.root, 'reports')).catch(
                            () => undefined
                        )
                    ).toBeUndefined();
                },
                10 * 60 * 1_000
            );
            test.skipIf(!selectedRuntimes.includes(runtime))(
                `${runner} on ${runtime} returns exact results through the public CLI and resumes`,
                async () => {
                    if (!process.env.OPENROUTER_API_KEY)
                        throw new Error('OPENROUTER_API_KEY is required');
                    if (runtime === 'e2b' && !process.env.E2B_API_KEY)
                        throw new Error('E2B_API_KEY is required');
                    const fixture = await createFixture(runtime, runner);
                    const env = testEnvironment(fixture.home, true, runtime === 'e2b');
                    const result = await command(fixture.root, env, [
                        'run',
                        fixture.packageDirectory,
                        '--workspace',
                        `notes=${fixture.notes}`,
                        '--connection',
                        'openrouter',
                        '--task',
                        'Remember the codeword meadow. Use your existing shell tool to run ./outcome-probe.sh in the workspace. Do not recreate the results in your reply. Then reply exactly: outcomes-ready.',
                        '--json',
                    ]);
                    expect(result.code, result.stderr).toBe(0);
                    const events = parseEvents(result.stdout);
                    expect(
                        events.some((event) => event.type === 'tool.completed')
                    ).toBeTrue();
                    expect(
                        events.filter((event) => event.type === 'run.completed')
                    ).toHaveLength(1);
                    const available = events.findIndex(
                        (event) => event.type === 'outcome.available'
                    );
                    expect(available).toBeGreaterThan(0);
                    expect(available).toBeLessThan(
                        events.findIndex((event) => event.type === 'run.completed')
                    );
                    const runId = events[0]?.run_id;
                    if (!runId) throw new Error('Run identity missing');
                    const run = await new RunStore(fixture.home).read(runId);
                    const localEnv = testEnvironment(fixture.home, false, false);
                    const inspected = await command(fixture.root, localEnv, [
                        'outcome',
                        runId,
                        '--json',
                    ]);
                    expect(inspected.code, inspected.stderr).toBe(0);
                    const { outcome, application } = JSON.parse(inspected.stdout) as {
                        outcome: RunOutcome;
                        application: { state: string };
                    };
                    expect(application.state).toBe(
                        runtime === 'e2b' ? 'pending' : 'present'
                    );
                    expect(outcome.completeness).toBe('complete');
                    expect(outcome.summary).toBe('Harness-produced result');
                    expect(
                        outcome.changesets.map((change) => change.workspace)
                    ).toEqual([{ kind: 'primary' }, { kind: 'named', name: 'notes' }]);
                    expect(outcome.changesets[0]?.stats).toMatchObject({
                        additions: 1,
                        modifications: 2,
                        deletions: 1,
                    });
                    expect(outcome.links).toMatchObject([
                        {
                            kind: 'pull_request',
                            uri: 'https://github.com/example/project/pull/42',
                        },
                    ]);
                    const store = new OutcomeStore(fixture.home);
                    const binary = outcome.artifacts.find(
                        (artifact) => artifact.name === 'original.bin'
                    );
                    if (!binary) throw new Error('Binary artifact missing');
                    expect(await readFile(await store.blob(binary.content))).toEqual(
                        Buffer.from([0, 1, 255])
                    );
                    if (runtime === 'e2b') {
                        expect(
                            await readFile(join(fixture.root, 'modify.txt'), 'utf8')
                        ).toBe('before\n');
                        expect(
                            await readFile(join(fixture.notes, 'notes.txt'), 'utf8')
                        ).toBe('before notes\n');
                        const applied = await command(fixture.root, localEnv, [
                            'outcome',
                            outcome.id,
                            '--apply',
                            '--json',
                        ]);
                        expect(applied.code, applied.stderr).toBe(0);
                        expect(JSON.parse(applied.stdout).application.state).toBe(
                            'applied'
                        );
                    }
                    expect(
                        await readFile(join(fixture.root, 'modify.txt'), 'utf8')
                    ).toBe('after\n');
                    expect(
                        await readFile(join(fixture.root, 'added.txt'), 'utf8')
                    ).toBe('added\n');
                    expect(
                        await lstat(join(fixture.root, 'delete.txt')).catch(
                            () => undefined
                        )
                    ).toBeUndefined();
                    expect(
                        (await stat(join(fixture.root, 'mode.sh'))).mode & 0o777
                    ).toBe(0o755);
                    expect(
                        await readFile(join(fixture.notes, 'notes.txt'), 'utf8')
                    ).toBe('after notes\n');
                    const destination = join(fixture.directory, 'exported');
                    const exported = await command(fixture.root, localEnv, [
                        'outcome',
                        outcome.id,
                        '--export',
                        destination,
                        '--json',
                    ]);
                    expect(exported.code, exported.stderr).toBe(0);
                    expect(
                        await readFile(join(destination, 'artifacts', 'original.bin'))
                    ).toEqual(Buffer.from([0, 1, 255]));
                    if (!run.session_id)
                        throw new Error('Resumable session identity missing');
                    const resumed = await command(fixture.root, env, [
                        'resume',
                        run.session_id,
                        '--task',
                        'What codeword did I ask you to remember in the previous run? Reply with exactly that word. Do not use tools.',
                        '--json',
                    ]);
                    expect(resumed.code, resumed.stderr).toBe(0);
                    const resumedEvents = parseEvents(resumed.stdout);
                    const text = resumedEvents
                        .filter((event) => event.type === 'output.text')
                        .map((event) =>
                            event.data && typeof event.data === 'object'
                                ? String(Reflect.get(event.data, 'text') ?? '')
                                : ''
                        )
                        .join('');
                    expect(text.toLowerCase()).toContain('meadow');
                    expect(
                        resumedEvents.some(
                            (event) => event.type === 'outcome.available'
                        )
                    ).toBeTrue();
                    expect(await store.read(outcome.id)).toEqual(outcome);
                },
                10 * 60 * 1_000
            );
        }
    }
});

async function observedContext(store: OutcomeStore, outcome: RunOutcome) {
    const observed = outcome.artifacts.find(
        (artifact) => artifact.name === 'native-context.json'
    );
    if (!observed)
        throw new Error('Native harness did not observe engine instructions');
    const system = JSON.parse(
        await readFile(await store.blob(observed.content), 'utf8')
    ) as string[];
    const context = system.join('\n');
    expect(context.split('<workbench_context>')).toHaveLength(2);
    expect(context.split('<workbench_runtime>')).toHaveLength(2);
    expect(context.indexOf('<workbench_context>')).toBeLessThan(
        context.indexOf('# Outcome conformance probe')
    );
    return context;
}

async function createFixture(runtime: string, runner: string, observeContext = false) {
    const directory = await realpath(
        await mkdtemp(join(tmpdir(), 'workbench-harness-outcomes-'))
    );
    directories.push(directory);
    const root = join(directory, 'project');
    const notes = join(directory, 'notes');
    const home = join(directory, 'home');
    homes.push({ path: home, runtime });
    const packageDirectory = join(root, '.workbenches', 'probe');
    await Promise.all([mkdir(packageDirectory, { recursive: true }), mkdir(notes)]);
    await seedModelCatalogFixture(home);
    if (observeContext && runner === 'opencode') {
        const plugins = join(packageDirectory, 'runner', 'plugins');
        await mkdir(plugins, { recursive: true });
        // Observe native system instructions, not agent reasoning or credentials.
        // Local only: this test hook must not add plugin bootstrap dependencies
        // to the otherwise unmodified Docker and E2B harness images.
        // This fixture-only hook does not alter the harness prompt or its tools.
        await writeFile(
            join(plugins, 'context-observer.ts'),
            [
                'export default async () => ({',
                '  "experimental.chat.system.transform": async (_input, output) => {',
                '    if (output.system.some(text => text.includes("<workbench_context>"))) {',
                '      await Bun.write(process.env.WORKBENCH_OUTPUT_DIR + "/native-context.json", JSON.stringify(output.system));',
                '    }',
                '  },',
                '});',
                '',
            ].join('\n')
        );
    }
    const reusedImage =
        runtime === 'docker'
            ? process.env[`WORKBENCH_OUTCOME_DOCKER_${runner.toUpperCase()}_IMAGE`]
            : undefined;
    const dockerfile = reusedImage
        ? [`FROM ${reusedImage}`, '']
        : runner === 'opencode'
          ? [
                'FROM ghcr.io/anomalyco/opencode:1.18.30',
                'USER root',
                'RUN apk add --no-cache git tar',
                '',
            ]
          : [
                'FROM node:22-bookworm-slim',
                'RUN apt-get update && apt-get install -y --no-install-recommends git tar ca-certificates && rm -rf /var/lib/apt/lists/*',
                'RUN npm install --global @earendil-works/pi-coding-agent@0.84.3',
                '',
            ];
    await writeFile(
        join(packageDirectory, 'Dockerfile.workbench'),
        dockerfile.join('\n')
    );
    await writeFile(
        join(packageDirectory, 'instructions.md'),
        '# Outcome conformance probe\n\nUse existing tools to carry out the requested work.\n'
    );
    await writeFile(
        join(packageDirectory, 'workbench.yml'),
        Bun.YAML.stringify({
            spec: 0,
            version: '0.0.1-e2e',
            name: `outcome-${runner}-${runtime}`,
            runner,
            ...(observeContext && runner === 'opencode'
                ? { runner_config: './runner' }
                : {}),
            model: { id: testModel, routes: [{ provider: 'openrouter' }] },
            instructions: './instructions.md',
            skills: [],
            tools: ['sh'],
            mcps: [],
            env: {},
            runtime,
            ...(runtime === 'local'
                ? {}
                : {
                      image: { build: './Dockerfile.workbench', context: '.' },
                  }),
            workspaces: { notes: { required: true, access: 'read-write' } },
        })
    );
    await Promise.all([
        writeFile(join(root, 'modify.txt'), 'before\n'),
        writeFile(join(root, 'delete.txt'), 'delete\n'),
        writeFile(join(root, 'mode.sh'), '#!/bin/sh\n'),
        writeFile(join(notes, 'notes.txt'), 'before notes\n'),
    ]);
    await chmod(join(root, 'mode.sh'), 0o644);
    await writeFile(
        join(root, 'outcome-probe.sh'),
        [
            '#!/bin/sh',
            'set -eu',
            'printf "after\\n" > modify.txt',
            'printf "added\\n" > added.txt',
            'rm delete.txt',
            'chmod 755 mode.sh',
            'printf "after notes\\n" > "$WORKBENCH_WORKSPACE_NOTES/notes.txt"',
            'printf "\\000\\001\\377" > "$WORKBENCH_OUTPUT_DIR/original.bin"',
            'printf "<h1>Report</h1>" > "$WORKBENCH_OUTPUT_DIR/Report.html"',
            'printf \'{"version":1,"summary":"Harness-produced result","links":[{"label":"Example PR","uri":"https://github.com/example/project/pull/42","kind":"pull_request"}]}\' > "$WORKBENCH_OUTPUT_DIR/outcome.json"',
            '',
        ].join('\n')
    );
    await chmod(join(root, 'outcome-probe.sh'), 0o755);
    const reportMarker = `retained-${crypto.randomUUID()}`;
    const reportLogo =
        '<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36"><rect width="36" height="36" fill="purple"/></svg>\n';
    const html = `<!doctype html><html><head><link rel="stylesheet" href="../assets/report.css"></head><body><h1>VERSION ONE</h1><img src="../assets/logo.svg" alt="Report logo"><ul><li>${reportMarker}</li></ul></body></html>\n`;
    await writeFile(
        join(root, 'deliverable-probe.sh'),
        [
            '#!/bin/sh',
            'set -eu',
            'mkdir -p "$WORKBENCH_OUTPUT_DIR/reports" "$WORKBENCH_OUTPUT_DIR/assets"',
            `printf '%s' '${html}' > "$WORKBENCH_OUTPUT_DIR/reports/report.html"`,
            `printf '%s' '${reportLogo}' > "$WORKBENCH_OUTPUT_DIR/assets/logo.svg"`,
            'printf "body { color: purple; }\\n" > "$WORKBENCH_OUTPUT_DIR/assets/report.css"',
            'printf \'{"version":1,"artifacts":[{"path":"reports/report.html","name":"My report"}]}\' > "$WORKBENCH_OUTPUT_DIR/outcome.json"',
            '',
        ].join('\n')
    );
    await chmod(join(root, 'deliverable-probe.sh'), 0o755);
    return { directory, root, notes, home, packageDirectory, reportMarker, reportLogo };
}

function testEnvironment(
    home: string,
    modelKey: boolean,
    e2bKey: boolean
): Record<string, string> {
    const env = Object.fromEntries(
        ['PATH', 'HOME', 'TMPDIR', 'USER', 'LANG', 'LC_ALL', 'TERM'].flatMap((name) =>
            process.env[name] ? [[name, process.env[name] as string]] : []
        )
    );
    return {
        ...env,
        HOME: home,
        ...(process.env.DOCKER_CONFIG || process.env.HOME
            ? {
                  DOCKER_CONFIG:
                      process.env.DOCKER_CONFIG ??
                      join(process.env.HOME as string, '.docker'),
              }
            : {}),
        WORKBENCH_HOME: home,
        DO_NOT_TRACK: '1',
        ...(modelKey
            ? { OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY as string }
            : {}),
        ...(e2bKey ? { E2B_API_KEY: process.env.E2B_API_KEY as string } : {}),
    };
}

async function command(cwd: string, env: Record<string, string>, args: string[]) {
    const executable = process.env.WORKBENCH_OUTCOME_CLI
        ? [process.env.WORKBENCH_OUTCOME_CLI]
        : [process.execPath, cli];
    const child = Bun.spawn([...executable, ...args], {
        cwd,
        env,
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 5 * 60 * 1_000,
        killSignal: 'SIGKILL',
    });
    let inputRequired = '';
    let rejectedDirectories = 0;
    const capture = async () => {
        const reader = child.stdout.getReader();
        const decoder = new TextDecoder();
        let output = '';
        let pending = '';
        while (true) {
            const next = await reader.read();
            if (next.done) return output + decoder.decode();
            const text = decoder.decode(next.value, { stream: true });
            output += text;
            pending += text;
            const lines = pending.split('\n');
            pending = lines.pop() ?? '';
            for (const line of lines) {
                let event: WorkbenchEvent;
                try {
                    event = JSON.parse(line);
                } catch {
                    continue;
                }
                if (event.type !== 'input.requested' || inputRequired) continue;
                const request = event.data as {
                    id?: string;
                    kind?: string;
                    action?: string;
                };
                if (
                    request.kind === 'permission' &&
                    request.action === 'external_directory' &&
                    request.id &&
                    rejectedDirectories < 3
                ) {
                    // Exercise the user's Reject action, never grant access to
                    // mistyped paths, earlier outboxes or parent run directories.
                    rejectedDirectories++;
                    try {
                        await new RunDispatcher(env.WORKBENCH_HOME as string)
                            .handle(event.run_id)
                            .respondToPermission(request.id, 'reject');
                        continue;
                    } catch {
                        // Keep the original request as the failure diagnostic.
                    }
                }
                inputRequired = `Headless conformance test unexpectedly requested input: ${JSON.stringify(event.data)}`;
                child.kill('SIGTERM');
            }
        }
    };
    const [stdout, stderr, code] = await Promise.all([
        capture(),
        new Response(child.stderr).text(),
        child.exited,
    ]);
    const failureEvents = code
        ? stdout.split('\n').flatMap((line) => {
              try {
                  const event = JSON.parse(line) as WorkbenchEvent;
                  return ['run.failed', 'outcome.failed'].includes(event.type)
                      ? [JSON.stringify(event)]
                      : [];
              } catch {
                  return [];
              }
          })
        : [];
    return {
        stdout,
        stderr: [stderr, inputRequired, ...failureEvents].filter(Boolean).join('\n'),
        code: inputRequired ? code || 1 : code,
    };
}

function deliveryDiagnostic(events: WorkbenchEvent[]): string {
    return JSON.stringify({
        reply: events
            .filter((event) => event.type === 'output.text')
            .map((event) => (event.data as { text?: string }).text ?? '')
            .join(''),
        tools: events
            .filter((event) => event.type === 'tool.completed')
            .map((event) => event.data),
    });
}

function parseEvents(source: string): WorkbenchEvent[] {
    return source
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line) as WorkbenchEvent);
}
