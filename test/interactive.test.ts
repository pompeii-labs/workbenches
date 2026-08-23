import { describe, expect, test } from 'bun:test';

import type { WorkbenchEvent } from '../src/execution.js';
import { startInteractiveWorkbench } from '../src/interactive.js';
import type { ResolvedReference } from '../src/references.js';
import {
    type RunnerSession,
    type RunnerSessionAdapter,
    RunnerSessionRegistry,
    type RunnerSessionStartOptions,
} from '../src/runner-session.js';
import { supportedRunnerDeclaration } from './runner-adapter-contract.js';

describe('runner-neutral interactive host', () => {
    test('normalizes runner permission requests and returns the host decision', async () => {
        const events: WorkbenchEvent[] = [];
        const decisions: string[] = [];
        const adapter = new FakeAdapter({ requestPermission: true });
        const session = await startInteractiveWorkbench({
            resolved: reference(),
            onEvent: (event) => void events.push(event),
            onPermission: async (request) => {
                expect(request.action).toBe('external_directory');
                return 'allow_once' as const;
            },
            dependencies: dependencies(adapter),
        });

        await session.send('inspect');
        decisions.push(...adapter.permissionDecisions);
        await session.close();

        expect(decisions).toEqual(['allow_once']);
        expect(events.find((event) => event.type === 'input.requested')).toMatchObject({
            data: {
                id: 'permission-1',
                kind: 'permission',
                action: 'external_directory',
                resources: ['/outside/*'],
                options: ['allow_once', 'allow_always', 'reject'],
            },
        });
    });

    test('rejects a permission safely when no interactive handler exists', async () => {
        const adapter = new FakeAdapter({ requestPermission: true });
        const session = await startInteractiveWorkbench({
            resolved: reference(),
            onEvent: () => {},
            dependencies: dependencies(adapter),
        });

        await session.send('inspect');
        await session.close();
        expect(adapter.permissionDecisions).toEqual(['reject']);
    });

    test('owns Workbench lifecycle while an adapter owns native transport', async () => {
        const events: WorkbenchEvent[] = [];
        const adapter = new FakeAdapter();
        const session = await startInteractiveWorkbench({
            resolved: reference(),
            onEvent: (event) => {
                events.push(event);
            },
            dependencies: dependencies(adapter),
        });

        await session.send('  first turn  ');
        expect(session.runnerSessionId).toBe('native-session-1');
        await session.close();

        expect(adapter.prompts).toEqual(['first turn']);
        expect(events.map((event) => event.type)).toEqual([
            'run.started',
            'run.ready',
            'turn.started',
            'output.text',
            'turn.completed',
            'run.completed',
        ]);
        expect(events.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5, 6]);
        expect(events[4]?.data).toEqual({ index: 1, reason: 'stop' });
    });

    test('normalizes turn cancellation without terminating the session', async () => {
        const events: WorkbenchEvent[] = [];
        const adapter = new FakeAdapter({ waitForCancellation: true });
        const session = await startInteractiveWorkbench({
            resolved: reference(),
            onEvent: (event) => {
                events.push(event);
            },
            dependencies: dependencies(adapter),
        });

        const turn = session.send('long turn');
        await adapter.started;
        await session.cancelTurn();
        await turn;
        await session.send('next turn');
        await session.close();

        expect(adapter.cancellations).toBe(1);
        expect(events.filter((event) => event.type === 'turn.completed')).toEqual([
            expect.objectContaining({ data: { index: 1, reason: 'cancelled' } }),
            expect.objectContaining({ data: { index: 2, reason: 'stop' } }),
        ]);
        expect(events.at(-1)?.type).toBe('run.completed');
    });

    test('turn failures terminate the Workbench run truthfully', async () => {
        const events: WorkbenchEvent[] = [];
        const adapter = new FakeAdapter({
            failure: new Error('native transport failed'),
        });
        const session = await startInteractiveWorkbench({
            resolved: reference(),
            onEvent: (event) => {
                events.push(event);
            },
            dependencies: dependencies(adapter),
        });

        await expect(session.send('fail')).rejects.toThrow('native transport failed');
        await expect(session.send('too late')).rejects.toThrow('session is closed');
        expect(events.at(-1)).toMatchObject({
            type: 'run.failed',
            data: { message: 'native transport failed' },
        });
        expect(adapter.closes).toBe(1);
    });

    test('close failures terminate the Workbench run truthfully', async () => {
        const events: WorkbenchEvent[] = [];
        const adapter = new FakeAdapter({
            closeFailure: new Error('native cleanup failed'),
        });
        const session = await startInteractiveWorkbench({
            resolved: reference(),
            onEvent: (event) => {
                events.push(event);
            },
            dependencies: dependencies(adapter),
        });

        await expect(session.close()).rejects.toThrow('native cleanup failed');
        expect(events.at(-1)).toMatchObject({
            type: 'run.failed',
            data: { message: 'native cleanup failed' },
        });
        expect(adapter.closes).toBe(1);
    });
});

class FakeAdapter implements RunnerSessionAdapter {
    readonly runner = 'opencode';
    readonly declaration = supportedRunnerDeclaration('opencode');
    readonly prompts: string[] = [];
    cancellations = 0;
    closes = 0;
    readonly permissionDecisions: string[] = [];
    private host?: RunnerSessionStartOptions['host'];
    private release?: () => void;
    private readonly markStarted: () => void;
    readonly started: Promise<void>;
    private readonly options: {
        waitForCancellation?: boolean;
        failure?: Error;
        closeFailure?: Error;
        requestPermission?: boolean;
    };

    constructor(
        options: {
            waitForCancellation?: boolean;
            failure?: Error;
            closeFailure?: Error;
            requestPermission?: boolean;
        } = {}
    ) {
        this.options = options;
        let markStarted!: () => void;
        this.started = new Promise((resolve) => {
            markStarted = resolve;
        });
        this.markStarted = markStarted;
    }

    async start(options: RunnerSessionStartOptions): Promise<RunnerSession> {
        this.host = options.host;
        return {
            id: 'native-session-1',
            prompt: (input) => this.prompt(input),
            cancelTurn: () => this.cancelTurn(),
            close: () => this.close(),
        };
    }

    private async prompt(input: string) {
        this.prompts.push(input);
        this.markStarted();
        if (this.options.failure) throw this.options.failure;
        if (this.options.waitForCancellation && this.prompts.length === 1) {
            await new Promise<void>((resolve) => {
                this.release = resolve;
            });
        }
        if (this.options.requestPermission) {
            const decision = await this.host?.requestPermission({
                id: 'permission-1',
                action: 'external_directory',
                resources: ['/outside/*'],
                message: 'Allow external directory for /outside/*?',
                allowAlways: true,
            });
            if (decision) this.permissionDecisions.push(decision);
        }
        await this.host?.emit({ type: 'output.text', data: { text: 'done' } });
        return { reason: 'stop' };
    }

    private async cancelTurn() {
        this.cancellations += 1;
        this.release?.();
    }

    private async close() {
        this.closes += 1;
        if (this.options.closeFailure) throw this.options.closeFailure;
    }
}

function dependencies(adapter: RunnerSessionAdapter) {
    return {
        env: {},
        findExecutable: (name: string) => `/bin/${name}`,
        registry: new RunnerSessionRegistry([adapter]),
        now: () => new Date('2026-08-18T12:00:00.000Z'),
    };
}

function reference(): ResolvedReference {
    return {
        workspaceDirectory: '/workspace',
        cleanup: async () => {},
        workbench: {
            manifestPath: '/repo/.workbenches/core/workbench.yml',
            packageDirectory: '/repo/.workbenches/core',
            repositoryDirectory: '/repo',
            instructionsPath: '/repo/.workbenches/core/instructions.md',
            skills: [],
            manifest: {
                spec: 0,
                version: '0.1.0',
                name: 'fixture-core',
                runner: 'opencode',
                model: 'openrouter/openai/gpt-5.6-terra',
                instructions: './instructions.md',
                skills: [],
                tools: [],
                mcps: [],
                env: {},
                runtime: 'local',
            },
        },
    };
}
