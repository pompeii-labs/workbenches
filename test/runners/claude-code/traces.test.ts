import { afterAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter } from 'node:path';
import { ModelRouter } from '../../../src/models/index.js';
import { join } from '../../../src/platform/paths.js';
import { ClaudeCodeCost } from '../../../src/runners/claude-code/cost.js';
import { ClaudeCodeSessionAdapter } from '../../../src/runners/claude-code/session.js';
import type {
    RunnerPermissionDecision,
    RunnerPermissionRequest,
    RunnerQuestionRequest,
    RunnerQuestionResponse,
    RunnerSession,
    RunnerSessionContext,
} from '../../../src/runners/session.js';
import type { WorkbenchEventDraft } from '../../../src/runs/events.js';
import { modelCatalogFixture } from '../../model-catalog-fixture.js';
import { executableScript } from '../../platform.js';
import { claudeCodeWorkbench, PREPARED } from './fixture.js';

const fixtures = join(import.meta.dir, '..', '..', 'fixtures', 'claude-code');
const root = await mkdtemp(join(tmpdir(), 'claude-code-traces-'));
const bin = join(root, 'bin');
await mkdir(bin);
await writeFile(
    join(bin, 'claude'),
    `#!/usr/bin/env bun\nawait import(${JSON.stringify(new URL('./replay.ts', import.meta.url).href)});\n`
);
await executableScript(join(bin, 'claude'));
afterAll(() => rm(root, { recursive: true, force: true }));
const workbench = claudeCodeWorkbench(root);

interface Replay {
    session: RunnerSession;
    events: WorkbenchEventDraft[];
    permissions: RunnerPermissionRequest[];
    questions: RunnerQuestionRequest[];
    /** The ids of host requests the session withdrew. */
    withdrawn: string[];
    prompts: string[];
    finish(): Promise<ReplayReport>;
}

interface ReplayReport {
    argv: string[];
    cwd: string;
    environment: Record<string, string>;
    violations: string[];
    remainingInputs: number;
    leftovers: unknown[];
}

let replays = 0;

/** Starts a real session whose `claude` is the fake that replays a recorded trace. */
async function replay(
    trace: string,
    options: {
        permission?: (
            request: RunnerPermissionRequest
        ) => Promise<RunnerPermissionDecision>;
        question?: (request: RunnerQuestionRequest) => Promise<RunnerQuestionResponse>;
        session?: RunnerSessionContext;
        cost?: ClaudeCodeCost;
    } = {}
): Promise<Replay> {
    replays += 1;
    const fixture = join(fixtures, `${trace}.jsonl`);
    const report = join(root, `${trace}-${replays}.json`);
    const events: WorkbenchEventDraft[] = [];
    const permissions: RunnerPermissionRequest[] = [];
    const questions: RunnerQuestionRequest[] = [];
    const withdrawn: string[] = [];
    const session = await new ClaudeCodeSessionAdapter({
        prepare: async () => {
            throw new Error('replays start prepared sessions');
        },
    }).startPrepared(
        {
            workbench,
            workspaceDirectory: root,
            environment: {
                PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
                HOME: root,
                REPLAY_FIXTURE: fixture,
                REPLAY_REPORT: report,
                CLAUDECODE: '1',
                CLAUDE_CODE_USE_BEDROCK: '1',
                ANTHROPIC_BASE_URL: 'https://inherited.invalid',
            },
            configuration: new ModelRouter(modelCatalogFixture).resolve({ workbench }),
            ...(options.session ? { session: options.session } : {}),
            host: {
                emit: async (event) => void events.push(event),
                requestPermission: async (request) => {
                    permissions.push(request);
                    return options.permission ? options.permission(request) : 'reject';
                },
                requestQuestion: async (request) => {
                    questions.push(request);
                    return options.question
                        ? options.question(request)
                        : { outcome: 'rejected' };
                },
                withdrawRequest: async (id) => void withdrawn.push(id),
            },
        },
        {
            ...PREPARED,
            routeEnvironment: { ANTHROPIC_API_KEY: 'test-route-key' },
            ...(options.cost ? { cost: options.cost } : {}),
        }
    );
    const prompts = (await readFile(fixture, 'utf8'))
        .split('\n')
        .filter(Boolean)
        .map(
            (line) => JSON.parse(line) as { dir: string; data: Record<string, unknown> }
        )
        .filter((step) => step.dir === 'in' && step.data.type === 'user')
        .map((step) => String((step.data.message as Record<string, unknown>).content));
    return {
        session,
        events,
        permissions,
        questions,
        withdrawn,
        prompts,
        async finish() {
            await session.close();
            const result = JSON.parse(await readFile(report, 'utf8')) as ReplayReport;
            expect(result.violations).toEqual([]);
            expect(result.remainingInputs).toBe(0);
            expect(result.leftovers).toEqual([]);
            expect(result.environment).toEqual({
                ANTHROPIC_API_KEY: 'test-route-key',
                CLAUDE_CONFIG_DIR: '/staged/config',
                CLAUDE_SECURESTORAGE_CONFIG_DIR: '',
                CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
                CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '0',
            });
            expect(result.argv).toEqual([
                '-p',
                '--input-format',
                'stream-json',
                '--output-format',
                'stream-json',
                '--verbose',
                '--replay-user-messages',
                '--model',
                'claude-sonnet-4-5',
                '--setting-sources',
                'user',
                '--settings',
                '/staged/settings.json',
                '--strict-mcp-config',
                '--mcp-config',
                '/staged/mcp.json',
                '--append-system-prompt-file',
                '/staged/system.md',
                '--system-prompt-snapshot',
                'off',
                '--permission-prompt-tool',
                'stdio',
                ...(options.session?.nativeSessionId
                    ? ['--resume', options.session.nativeSessionId]
                    : ['--session-id', String(session.id)]),
            ]);
            return result;
        },
    };
}

function texts(events: WorkbenchEventDraft[]): string[] {
    return events
        .filter((event) => event.type === 'output.text')
        .map((event) => String(event.data.text));
}

function costs(events: WorkbenchEventDraft[]): unknown[] {
    return events
        .filter((event) => event.type === 'usage.updated')
        .map((event) => event.data.cost_usd);
}

function signal(): { promise: Promise<void>; fire: () => void } {
    let fire!: () => void;
    const promise = new Promise<void>((resolve) => (fire = resolve));
    return { promise, fire };
}

async function until(check: () => boolean, timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!check()) {
        if (Date.now() > deadline) throw new Error('timed out waiting for the replay');
        await Bun.sleep(10);
    }
}

describe('Claude Code recorded trace replay', () => {
    test('basic: two turns in one process, each closed by its own result', async () => {
        const run = await replay('basic');
        await expect(run.session.prompt(run.prompts[0] as string)).resolves.toEqual({
            reason: 'end_turn',
        });
        await expect(run.session.prompt(run.prompts[1] as string)).resolves.toEqual({
            reason: 'end_turn',
        });
        expect(texts(run.events)).toEqual(['ONE', 'TWO']);
        const outputs = run.events.filter((event) => event.type === 'output.text');
        expect(outputs[0]?.data.id).not.toBe(outputs[1]?.data.id);
        expect(costs(run.events)).toEqual([
            0.020271400000000002,
            expect.closeTo(0.0029314, 7),
        ]);
        expect(JSON.stringify(run.events)).not.toContain('thinking');
        await run.finish();
    });

    test('permission: allows Bash with its exact input, denies Write, sends no rules', async () => {
        const decisions: RunnerPermissionDecision[] = ['allow_once', 'reject'];
        const run = await replay('permission', {
            permission: async () => decisions.shift() ?? 'reject',
        });
        await expect(run.session.prompt(run.prompts[0] as string)).resolves.toEqual({
            reason: 'end_turn',
        });
        expect(run.permissions).toEqual([
            {
                id: expect.any(String),
                action: 'Bash',
                resources: ['/workspace/out.txt'],
                message:
                    'Allow Bash for echo hello > out.txt? Blocked path: /workspace/out.txt. Reason: Claude requested permissions to edit /workspace/out.txt which is a sensitive file.',
                allowAlways: true,
            },
            {
                id: expect.any(String),
                action: 'Write',
                resources: ['/workspace/notes.txt'],
                message:
                    'Allow Write for /workspace/notes.txt? Reason: Claude requested permissions to edit /workspace/notes.txt which is a sensitive file.',
                allowAlways: true,
            },
        ]);
        const completed = run.events
            .filter((event) => event.type === 'tool.completed')
            .map((event) => [event.data.name, event.data.status]);
        expect(completed).toEqual([
            ['Bash', 'completed'],
            ['Write', 'failed'],
        ]);
        expect(run.events.some((event) => event.type === 'file.changed')).toBe(false);
        expect(JSON.stringify(run.events)).not.toContain('echo hello');
        await run.finish();
    });

    test('question: answers AskUserQuestion with the chosen label', async () => {
        const run = await replay('question', {
            question: async () => ({ outcome: 'answered', answers: [['Blue']] }),
        });
        await expect(run.session.prompt(run.prompts[0] as string)).resolves.toEqual({
            reason: 'end_turn',
        });
        expect(run.questions[0]?.questions).toEqual([
            {
                question: 'Which color do you prefer?',
                header: 'Color',
                options: [
                    { label: 'Red', description: 'The color red' },
                    { label: 'Blue', description: 'The color blue' },
                ],
                multiple: false,
                custom: false,
            },
        ]);
        expect(texts(run.events)).toEqual(['You prefer the color blue.']);
        await run.finish();
    });

    test('steer_mid: steering written during a tool call folds into the same turn', async () => {
        let steered: Promise<{ delivered: Promise<void> } | undefined> | undefined;
        let session!: RunnerSession;
        let prompts: string[] = [];
        const run = await replay('steer_mid', {
            permission: async () => {
                steered = session.steer?.(prompts[1] as string);
                await steered;
                return 'allow_once';
            },
        });
        session = run.session;
        prompts = run.prompts;
        await expect(run.session.prompt(run.prompts[0] as string)).resolves.toEqual({
            reason: 'end_turn',
        });
        await expect((await steered)?.delivered).resolves.toBeUndefined();
        expect(texts(run.events).at(-1)).toBe('STEERED');
        await run.finish();
    });

    test('steer_late: steering without a tool call is held, rejected, then sent as its own turn', async () => {
        const run = await replay('steer_late');
        const first = run.session.prompt(run.prompts[0] as string);
        const steer = await run.session.steer?.(run.prompts[1] as string);
        await expect(first).resolves.toEqual({ reason: 'end_turn' });
        await expect(steer?.delivered).rejects.toThrow('turn ended');
        await expect(run.session.prompt(run.prompts[1] as string)).resolves.toEqual({
            reason: 'end_turn',
        });
        await expect(run.session.prompt(run.prompts[2] as string)).resolves.toEqual({
            reason: 'end_turn',
        });
        expect(texts(run.events)).toEqual(['FIRST', 'STEER', 'THIRD']);
        await run.finish();
    });

    test('interrupt2: interrupt cancels the queued steer and the turn, and the process stays usable', async () => {
        const asked = signal();
        const run = await replay('interrupt2', {
            permission: async () => {
                asked.fire();
                return 'allow_once';
            },
        });
        const turn = run.session.prompt(run.prompts[0] as string);
        await asked.promise;
        const steer = await run.session.steer?.(run.prompts[1] as string);
        await run.session.cancelTurn();
        await expect(turn).resolves.toEqual({ reason: 'cancelled' });
        await expect(steer?.delivered).rejects.toThrow('cancelled');
        await expect(run.session.prompt(run.prompts[2] as string)).resolves.toEqual({
            reason: 'end_turn',
        });
        expect(texts(run.events)).toEqual(['AFTER']);
        expect(run.events).toContainEqual({
            type: 'tool.completed',
            data: expect.objectContaining({ name: 'Bash', status: 'failed' }),
        });
        await run.finish();
    });

    test('interrupt_pending2: interrupt withdraws a pending permission without a reply', async () => {
        const asked = signal();
        let decide!: (decision: RunnerPermissionDecision) => void;
        const run = await replay('interrupt_pending2', {
            permission: () => {
                asked.fire();
                return new Promise((resolve) => (decide = resolve));
            },
        });
        const turn = run.session.prompt(run.prompts[0] as string);
        await asked.promise;
        await run.session.cancelTurn();
        await expect(turn).resolves.toEqual({ reason: 'cancelled' });
        // The host stops offering the request Claude Code withdrew.
        expect(run.permissions).toHaveLength(1);
        await until(() => run.withdrawn.length > 0);
        expect(run.withdrawn).toEqual([run.permissions[0]?.id as string]);
        // A late answer is never sent.
        decide('allow_once');
        await Bun.sleep(50);
        await run.finish();
    });

    test('interrupt: an unprompted background turn is session activity, not a reply', async () => {
        const run = await replay('interrupt');
        await expect(run.session.prompt(run.prompts[0] as string)).resolves.toEqual({
            reason: 'end_turn',
        });
        await until(() => costs(run.events).length === 2);
        expect(texts(run.events)).toEqual([
            "Command is running in the background. You'll be notified when it completes.",
        ]);
        expect(run.events).toContainEqual({
            type: 'runner.event',
            data: { native_type: 'unprompted_turn' },
        });
        expect(run.events).toContainEqual({
            type: 'tool.started',
            data: expect.objectContaining({ name: 'Read', title: 'Read' }),
        });
        await run.finish();
    });

    test('resume: reopens the native session and reports cost from the recorded total', async () => {
        // The earlier process recorded its last cumulative total.
        let recorded: number | undefined = 0.0232;
        const cost = await ClaudeCodeCost.open('metered', {
            read: async () => recorded,
            write: async (total) => {
                recorded = total;
            },
        });
        const run = await replay('resume', {
            session: {
                id: 'wb_resume',
                directory: join(root, 'native'),
                nativeSessionId: 'resumed-native-session',
            },
            cost,
        });
        expect(run.session.id).toBe('resumed-native-session');
        await expect(run.session.prompt(run.prompts[0] as string)).resolves.toEqual({
            reason: 'end_turn',
        });
        const [delta] = costs(run.events);
        expect(delta).toBeCloseTo(0.0031395);
        expect(run.session.id).toBe('resumed-native-session');
        await run.finish();
        expect(recorded).toBeCloseTo(0.0263395);
    });
});
