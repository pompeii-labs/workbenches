import { describe, expect, test } from 'bun:test';
import {
    chmod,
    mkdir,
    mkdtemp,
    readFile,
    realpath,
    rm,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OutcomeStore } from '../../src/outcomes/store.js';
import type { RunControlReceipt } from '../../src/runs/control.js';
import { StoredRunHandle } from '../../src/runs/handle.js';
import { RunStore } from '../../src/runs/store.js';
import type { RunSnapshot } from '../../src/runs/supervision.js';
import { DockerManagedContainers } from '../../src/runtimes/docker/containers.js';
import { E2BSdkClient } from '../../src/runtimes/e2b/sdk.js';
import type { SessionInputResult } from '../../src/sessions/control.js';
import { seedModelCatalogFixture } from '../model-catalog-fixture.js';

const enabled = process.env.WORKBENCH_HEADLESS_E2E === '1';
const selected = (process.env.WORKBENCH_HEADLESS_RUNTIMES ?? 'local,docker,e2b').split(
    ','
);
const cli = join(import.meta.dir, '..', '..', 'src', 'cli.ts');

describe.skipIf(!enabled)('Real headless CLI supervision', () => {
    for (const runtime of ['local', 'docker', 'e2b'])
        for (const runner of ['opencode', 'pi']) {
            test.skipIf(!selected.includes(runtime))(
                `${runner} on ${runtime} supervises input and resumes with durable results`,
                async () => {
                    if (!process.env.OPENROUTER_API_KEY)
                        throw new Error('OPENROUTER_API_KEY is required');
                    if (runtime === 'e2b' && !process.env.E2B_API_KEY)
                        throw new Error('E2B_API_KEY is required');
                    const root = await realpath(
                        await mkdtemp(join(tmpdir(), 'headless-e2e-'))
                    );
                    const home = join(root, 'home');
                    const workspace = join(root, 'project');
                    const packageDirectory = join(workspace, '.workbenches', 'probe');
                    const bin = join(root, 'bin');
                    const executable = process.env.WORKBENCH_HEADLESS_BINARY;
                    const shellQuote = (value: string) =>
                        `'${value.replaceAll("'", `'"'"'`)}'`;
                    const command = (
                        executable ? [executable] : [process.execPath, cli]
                    )
                        .map(shellQuote)
                        .join(' ');
                    await mkdir(bin, { recursive: true });
                    await writeFile(
                        join(bin, 'wb-dev'),
                        `#!/bin/sh\nexec ${command} "$@"\n`,
                        { mode: 0o700 }
                    );
                    await chmod(join(bin, 'wb-dev'), 0o700);
                    await mkdir(packageDirectory, { recursive: true });
                    await seedModelCatalogFixture(home);
                    await writeFile(
                        join(packageDirectory, 'instructions.md'),
                        'Perform the requested bounded work with your tools. Never inspect credentials or environment variables. Requested reports are user attachments, not project source files. Follow the current injected Workbench delivery contract automatically, including after continuation; publish returned files in the current delivery destination, never a previous attempt or the project workspace.' +
                            (runner === 'opencode'
                                ? ' On the first task, before any file changes, use your question tool to ask which report style to use, offering Standard and Quick. Use the answer and continue.'
                                : '')
                    );
                    if (runner === 'opencode')
                        await writeFile(
                            join(packageDirectory, 'opencode.json'),
                            JSON.stringify({
                                permission: { bash: 'ask', edit: 'ask' },
                            })
                        );
                    await writeFile(
                        join(packageDirectory, 'Dockerfile.workbench'),
                        runner === 'opencode'
                            ? 'FROM ghcr.io/anomalyco/opencode:1.18.30\nUSER root\nRUN apk add --no-cache git tar\n'
                            : 'FROM node:22-bookworm-slim\nRUN apt-get update && apt-get install -y --no-install-recommends git tar ca-certificates && rm -rf /var/lib/apt/lists/*\nRUN npm install --global @earendil-works/pi-coding-agent@0.84.3\n'
                    );
                    await writeFile(
                        join(packageDirectory, 'workbench.yml'),
                        Bun.YAML.stringify({
                            spec: 0,
                            version: '0.0.1-e2e',
                            name: `headless-${runner}-${runtime}`,
                            runner,
                            ...(runner === 'opencode'
                                ? { runner_config: './opencode.json' }
                                : {}),
                            model: {
                                id:
                                    process.env.WORKBENCH_HEADLESS_MODEL ??
                                    (runner === 'opencode'
                                        ? 'anthropic/claude-sonnet-4-5'
                                        : 'openai/gpt-5.4-mini'),
                                routes: [{ provider: 'openrouter' }],
                            },
                            instructions: './instructions.md',
                            skills: [],
                            tools: ['sh'],
                            mcps: [],
                            env: {},
                            runtime,
                            ...(runtime === 'local'
                                ? {}
                                : {
                                      image: {
                                          build: './Dockerfile.workbench',
                                          context: '.',
                                      },
                                  }),
                        })
                    );
                    const environment = Object.fromEntries(
                        [
                            'PATH',
                            'HOME',
                            'TMPDIR',
                            'USER',
                            'LANG',
                            'LC_ALL',
                            'TERM',
                            'DOCKER_CONFIG',
                            'OPENROUTER_API_KEY',
                            ...(runtime === 'e2b' ? ['E2B_API_KEY'] : []),
                        ].flatMap((key) =>
                            process.env[key] ? [[key, process.env[key]]] : []
                        )
                    );
                    Object.assign(environment, {
                        PATH: `${bin}:${environment.PATH}`,
                        WORKBENCH_HOME: home,
                    });
                    const invoke = async <T = RunSnapshot>(args: string[]) => {
                        const child = Bun.spawn([join(bin, 'wb-dev'), ...args], {
                            cwd: workspace,
                            env: environment,
                            stdin: 'ignore',
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
                            throw new Error(
                                `CLI did not return JSON (exit ${code}): ${stderr}`
                            );
                        }
                        return { code, stderr, result };
                    };
                    const finish = async (id: string) => {
                        for (let attempt = 0; attempt < 16; attempt++) {
                            const result = await invoke([
                                'wait',
                                id,
                                '--timeout',
                                '180',
                                '--json',
                            ]);
                            if (result.code !== 2) {
                                expect(
                                    result.code,
                                    result.stderr + JSON.stringify(result.result)
                                ).toBe(0);
                                return result.result;
                            }
                            const requests = result.result.pending_requests;
                            expect(requests.length).toBeGreaterThan(0);
                            for (const request of requests) {
                                expect(['permission', 'question']).toContain(
                                    request.kind
                                );
                                const answered = await invoke<SessionInputResult>([
                                    'answer',
                                    id,
                                    request.id,
                                    request.kind === 'permission'
                                        ? 'allow'
                                        : 'Standard',
                                    '--json',
                                ]);
                                expect(answered.code, answered.stderr).toBe(0);
                                expect(answered.result.receipt?.outcome).toBe(
                                    'accepted'
                                );
                            }
                        }
                        throw new Error('Too many fixture permission requests');
                    };
                    const store = new RunStore(home);
                    try {
                        const launch = await invoke<SessionInputResult>([
                            'run',
                            packageDirectory,
                            '--connection',
                            'openrouter',
                            '--task',
                            (runner === 'opencode'
                                ? 'Before any other tools, use the question tool to ask which report style to use, offering Standard and Quick. Wait for the answer, then continue. '
                                : '') +
                                'Remember the codeword saffron. First run sleep 3 to give the supervisor time to send input. Use tools to create scratch-note.txt in the current project containing permission-check followed by a newline, and return report.txt containing exactly first-version followed by a newline. Do not inspect environment variables. Finish in one sentence.',
                            '--detach',
                            '--json',
                        ]);
                        expect(launch.code, launch.stderr).toBe(0);
                        const id = launch.result.session_id;
                        const rejected = await invoke<{ receipt: RunControlReceipt }>([
                            'send',
                            id,
                            'Never implicitly queue this request',
                            '--json',
                        ]);
                        expect(rejected.code).toBe(1);
                        expect(rejected.result.receipt.error?.code).toBe('turn_active');
                        if (runner === 'opencode') {
                            let questioned = false;
                            for (let attempt = 0; attempt < 8; attempt++) {
                                const pending = await invoke([
                                    'wait',
                                    id,
                                    '--timeout',
                                    '30',
                                    '--json',
                                ]);
                                expect(
                                    pending.code,
                                    JSON.stringify(pending.result)
                                ).toBe(2);
                                for (const request of pending.result.pending_requests) {
                                    expect(['permission', 'question']).toContain(
                                        request.kind
                                    );
                                    const answered = await invoke<SessionInputResult>([
                                        'answer',
                                        id,
                                        request.id,
                                        request.kind === 'permission'
                                            ? 'allow'
                                            : 'Standard',
                                        '--json',
                                    ]);
                                    expect(answered.code, answered.stderr).toBe(0);
                                    questioned ||= request.kind === 'question';
                                }
                                if (questioned) break;
                            }
                            expect(
                                questioned,
                                'Missing requested native question'
                            ).toBeTrue();
                        }
                        const steered = await invoke<SessionInputResult>([
                            'send',
                            id,
                            'Keep the report filenames and contents exactly as requested. Keep all work bounded to this fixture.',
                            '--steer',
                            '--json',
                        ]);
                        expect(steered.code, steered.stderr).toBe(0);
                        expect(steered.result.receipt?.outcome).toBe('accepted');
                        const queued = await invoke<SessionInputResult>([
                            'send',
                            id,
                            'Return an updated report.txt containing exactly second-version followed by a newline. Mention the remembered codeword in your final sentence.',
                            '--queue',
                            '--json',
                        ]);
                        expect(queued.code, queued.stderr).toBe(0);
                        expect(queued.result.receipt?.disposition).toBe('queued');
                        const completed = await finish(id);
                        expect(completed.state).toBe('completed');
                        if (runner === 'opencode')
                            expect(
                                JSON.parse(
                                    await readFile(
                                        join(packageDirectory, 'opencode.json'),
                                        'utf8'
                                    )
                                )
                            ).not.toHaveProperty('$schema');
                        expect(completed.final.toLowerCase()).toContain('saffron');
                        const events = await store.readEvents(launch.result.run_id);
                        expect(
                            events.filter((event) => event.type === 'turn.completed')
                        ).toHaveLength(2);
                        if (runner === 'opencode') {
                            expect(
                                events.some((event) => event.type === 'input.requested')
                            ).toBeTrue();
                            expect(
                                events.some(
                                    (event) => event.type === 'question.requested'
                                )
                            ).toBeTrue();
                        }
                        const outcomes = new OutcomeStore(home);
                        if (!completed.outcome_id) throw new Error('Missing outcome');
                        const result = await outcomes.read(completed.outcome_id);
                        const report = result.artifacts.find(
                            (entry) => entry.name === 'report.txt'
                        );
                        if (!report)
                            throw new Error(
                                `Missing report: ${JSON.stringify({ final: completed.final, artifacts: result.artifacts.map((entry) => entry.name) })}`
                            );
                        expect(
                            await readFile(
                                await outcomes.artifactPath(result.id, report.id),
                                'utf8'
                            )
                        ).toBe('second-version\n');
                        const next = await invoke<SessionInputResult>([
                            'send',
                            id,
                            'What codeword do you remember? Return fresh-report.txt containing exactly resumed-version followed by a newline. Finish in one sentence.',
                            '--json',
                        ]);
                        expect(
                            next.code,
                            next.stderr + JSON.stringify(next.result)
                        ).toBe(0);
                        expect(next.result.session_id).toBe(id);
                        expect(next.result.run_id).not.toBe(launch.result.run_id);
                        const resumed = await finish(id);
                        expect(resumed.final.toLowerCase()).toContain('saffron');
                        if (!resumed.outcome_id)
                            throw new Error('Missing resumed outcome');
                        const fresh = await outcomes.read(resumed.outcome_id);
                        const freshReport = fresh.artifacts.find(
                            (entry) => entry.name === 'fresh-report.txt'
                        );
                        if (!freshReport)
                            throw new Error(
                                `Missing resumed report: ${JSON.stringify({ final: resumed.final, artifacts: fresh.artifacts.map((entry) => entry.name) })}`
                            );
                        expect(
                            await readFile(
                                await outcomes.artifactPath(fresh.id, freshReport.id),
                                'utf8'
                            )
                        ).toBe('resumed-version\n');
                        if (runtime === 'docker')
                            expect(
                                await (
                                    await DockerManagedContainers.connect(
                                        RunStore.scope(home)
                                    )
                                )?.list()
                            ).toEqual([]);
                        if (runtime === 'e2b')
                            expect(
                                await new E2BSdkClient(
                                    process.env.E2B_API_KEY as string
                                ).listManaged(RunStore.scope(home))
                            ).toEqual([]);
                    } finally {
                        for (const run of await store.list())
                            if (!RunStore.isTerminal(run.status)) {
                                const handle = new StoredRunHandle(home, run.id);
                                await handle
                                    .cancel('Headless fixture cleanup')
                                    .catch(() => {});
                                await Promise.race([
                                    handle.result.catch(() => {}),
                                    Bun.sleep(10_000),
                                ]);
                            }
                        if (runtime === 'e2b') {
                            const client = new E2BSdkClient(
                                process.env.E2B_API_KEY as string
                            );
                            for (const sandbox of await client.listManaged(
                                RunStore.scope(home)
                            ))
                                await client.killSandbox(sandbox.id);
                        }
                        if (process.env.WORKBENCH_HEADLESS_KEEP === '1')
                            console.error(`Headless fixture retained at ${root}`);
                        else await rm(root, { recursive: true, force: true });
                    }
                },
                10 * 60 * 1000
            );
        }
});
