import { describe, expect, test } from 'bun:test';
import { ModelRouter } from '../src/models/index.js';
import {
    RUNNER_CAPABILITIES,
    type RunnerAdapterDeclaration,
    type RunnerCapability,
    type RunnerPermissionDecision,
    type RunnerPermissionRequest,
    type RunnerQuestionRequest,
    type RunnerSession,
    type RunnerSessionAdapter,
} from '../src/runners/session.js';
import type { WorkbenchEventDraft } from '../src/runs/index.js';
import type { ResolvedWorkbench } from '../src/types.js';
import { activateModelCatalogFixture } from './model-catalog-fixture.js';

activateModelCatalogFixture();

export const RUNNER_CONFORMANCE_UNSAFE_VALUES = [
    'MUST_NOT_RENDER_REASONING',
    'MUST_NOT_RENDER_CREDENTIAL',
    'MUST_NOT_RENDER_COMMAND',
    'MUST_NOT_RENDER_TOOL_OUTPUT',
    'MUST_NOT_RENDER_IMAGE_DATA',
] as const;

export type RunnerConformanceScenario =
    | 'streaming_text'
    | 'tool_events'
    | 'permissions'
    | 'questions'
    | 'multi_turn'
    | 'steering'
    | 'image_input'
    | 'cancellation'
    | 'failures'
    | 'unknown_events';

export interface RunnerAdapterConformanceHarness {
    adapter: RunnerSessionAdapter;
    workbench: ResolvedWorkbench;
    arrange(scenario: RunnerConformanceScenario): void;
}

export function runnerAdapterContract(options: {
    name: string;
    createHarness: () => RunnerAdapterConformanceHarness;
}) {
    describe(`${options.name} runner adapter contract`, () => {
        test('declares every capability and its verified native surface', () => {
            const declaration = options.createHarness().adapter.declaration;

            expect(declaration.native.command.trim().length).toBeGreaterThan(0);
            expect(declaration.native.verified.length).toBeGreaterThan(0);
            for (const verified of declaration.native.verified) {
                expect(verified.version.trim().length).toBeGreaterThan(0);
                expect(verified.surfaces.length).toBeGreaterThan(0);
                expect(verified.surfaces.every((surface) => surface.trim())).toBe(true);
            }
            for (const capability of RUNNER_CAPABILITIES) {
                const support = declaration.capabilities[capability];
                expect(['supported', 'degraded', 'unsupported']).toContain(
                    support.status
                );
                if (support.status !== 'supported') {
                    expect(support.detail?.trim().length).toBeGreaterThan(0);
                }
            }
        });

        test('streams assistant text without exposing reasoning or credentials', async () => {
            if (!supported(options, 'streaming_text')) return;
            const harness = options.createHarness();
            harness.arrange('streaming_text');
            const observed = await start(harness);
            try {
                await observed.session.prompt('stream text');
                expect(observed.events).toContainEqual({
                    type: 'output.text',
                    data: expect.objectContaining({ text: 'Hello' }),
                });
                expect(observed.events).toContainEqual({
                    type: 'output.text',
                    data: expect.objectContaining({ text: ' world' }),
                });
                assertSafe(observed.events);
            } finally {
                await observed.session.close();
            }
        });

        test('normalizes tools, file changes, and usage without native payloads', async () => {
            if (
                !supported(options, 'tool_events') &&
                !supported(options, 'file_events') &&
                !supported(options, 'usage')
            ) {
                return;
            }
            const harness = options.createHarness();
            harness.arrange('tool_events');
            const observed = await start(harness);
            try {
                await observed.session.prompt('use tools');
                if (supported(options, 'tool_events')) {
                    expect(observed.events).toContainEqual({
                        type: 'tool.started',
                        data: {
                            id: 'call_contract',
                            name: 'write',
                            target: '/workspace/output.txt',
                        },
                    });
                    expect(observed.events).toContainEqual({
                        type: 'tool.completed',
                        data: expect.objectContaining({
                            id: 'call_contract',
                            name: 'write',
                            target: '/workspace/output.txt',
                            status: 'completed',
                        }),
                    });
                }
                if (supported(options, 'file_events')) {
                    expect(observed.events).toContainEqual({
                        type: 'file.changed',
                        data: {
                            path: '/workspace/output.txt',
                            operation: 'write',
                        },
                    });
                }
                if (supported(options, 'usage')) {
                    expect(observed.events).toContainEqual({
                        type: 'usage.updated',
                        data: expect.objectContaining({
                            kind: 'delta',
                            total_tokens: 12,
                            input_tokens: 5,
                            output_tokens: 7,
                            cost_usd: 0.001,
                        }),
                    });
                }
                assertSafe(observed.events);
            } finally {
                await observed.session.close();
            }
        });

        test('pauses for an explicit permission decision', async () => {
            if (!supported(options, 'permissions')) return;
            const harness = options.createHarness();
            harness.arrange('permissions');
            const observed = await start(harness, 'allow_once');
            try {
                await observed.session.prompt('request permission');
                expect(observed.permissions).toEqual([
                    {
                        id: 'permission_contract',
                        action: 'external_directory',
                        resources: ['/outside/*'],
                        message: 'Allow external directory for /outside/*?',
                        allowAlways: true,
                    },
                ]);
            } finally {
                await observed.session.close();
            }
        });

        test('pauses for a normalized question and returns the answer', async () => {
            if (!supported(options, 'questions')) return;
            const harness = options.createHarness();
            harness.arrange('questions');
            const observed = await start(harness);
            try {
                await observed.session.prompt('ask a question');
                expect(observed.questions).toEqual([
                    {
                        id: expect.any(String),
                        questions: [
                            {
                                question: 'Where should this deploy?',
                                options: [
                                    { label: 'Production' },
                                    { label: 'Staging' },
                                ],
                                multiple: false,
                                custom: false,
                            },
                        ],
                    },
                ]);
                assertSafe(observed.events);
            } finally {
                await observed.session.close();
            }
        });

        test('preserves one native session across multiple turns', async () => {
            if (!supported(options, 'multi_turn')) return;
            const harness = options.createHarness();
            harness.arrange('multi_turn');
            const observed = await start(harness);
            try {
                const id = observed.session.id;
                await observed.session.prompt('first');
                await observed.session.prompt('second');
                expect(observed.session.id).toBe(id);
                expect(id).toBeTruthy();
                expect(text(observed.events)).toBe('firstsecond');
            } finally {
                await observed.session.close();
            }
        });

        test('accepts host steering during an active turn', async () => {
            if (!supported(options, 'steering')) return;
            const harness = options.createHarness();
            harness.arrange('steering');
            const observed = await start(harness);
            try {
                const turn = observed.session.prompt('start');
                await observed.session.steer?.('change direction');
                await observed.session.cancelTurn();
                await expect(turn).resolves.toEqual({ reason: 'cancelled' });
                assertSafe(observed.events);
            } finally {
                await observed.session.close();
            }
        });

        test('accepts structured image input without leaking image data to events', async () => {
            if (!supported(options, 'image_input')) return;
            const harness = options.createHarness();
            harness.arrange('image_input');
            const observed = await start(harness);
            try {
                await observed.session.prompt({
                    text: 'inspect this image',
                    images: [
                        {
                            data: RUNNER_CONFORMANCE_UNSAFE_VALUES[4],
                            mimeType: 'image/png',
                            name: 'fixture.png',
                        },
                    ],
                });
                assertSafe(observed.events);
            } finally {
                await observed.session.close();
            }
        });

        test('cancels an active turn without terminating the host', async () => {
            if (!supported(options, 'cancellation')) return;
            const harness = options.createHarness();
            harness.arrange('cancellation');
            const observed = await start(harness);
            try {
                const turn = observed.session.prompt('wait');
                await observed.session.cancelTurn();
                await expect(turn).resolves.toEqual({ reason: 'cancelled' });
            } finally {
                await observed.session.close();
            }
        });

        test('surfaces native failures through a safe error', async () => {
            if (!supported(options, 'failures')) return;
            const harness = options.createHarness();
            harness.arrange('failures');
            const observed = await start(harness);
            try {
                await expect(observed.session.prompt('fail')).rejects.toThrow(
                    'session failed'
                );
                assertSafe(observed.events);
            } finally {
                await observed.session.close();
            }
        });

        test('reduces unknown native events to a payload-free marker', async () => {
            if (!supported(options, 'unknown_events')) return;
            const harness = options.createHarness();
            harness.arrange('unknown_events');
            const observed = await start(harness);
            try {
                await observed.session.prompt('future event');
                expect(observed.events).toContainEqual({
                    type: 'runner.event',
                    data: { native_type: 'future.event' },
                });
                assertSafe(observed.events);
            } finally {
                await observed.session.close();
            }
        });
    });
}

export function supportedRunnerDeclaration(
    command = 'fixture-runner'
): RunnerAdapterDeclaration {
    return {
        native: {
            command,
            verified: [{ version: 'fixture', surfaces: ['fixture'] }],
        },
        capabilities: Object.fromEntries(
            RUNNER_CAPABILITIES.map((capability) => [
                capability,
                { status: 'supported' },
            ])
        ) as RunnerAdapterDeclaration['capabilities'],
    };
}

function supported(
    options: { createHarness: () => RunnerAdapterConformanceHarness },
    capability: RunnerCapability
) {
    return (
        options.createHarness().adapter.declaration.capabilities[capability].status ===
        'supported'
    );
}

async function start(
    harness: RunnerAdapterConformanceHarness,
    decision: RunnerPermissionDecision = 'reject'
): Promise<{
    session: RunnerSession;
    events: WorkbenchEventDraft[];
    permissions: RunnerPermissionRequest[];
    questions: RunnerQuestionRequest[];
}> {
    const events: WorkbenchEventDraft[] = [];
    const permissions: RunnerPermissionRequest[] = [];
    const questions: RunnerQuestionRequest[] = [];
    const session = await harness.adapter.start({
        workbench: harness.workbench,
        workspaceDirectory: '/workspace',
        environment: {},
        configuration: new ModelRouter().resolve({
            workbench: harness.workbench,
        }),
        host: {
            emit: async (event) => void events.push(event),
            requestPermission: async (request) => {
                permissions.push(request);
                return decision;
            },
            requestQuestion: async (request) => {
                questions.push(request);
                return { outcome: 'answered', answers: [['Production']] };
            },
        },
    });
    return { session, events, permissions, questions };
}

function assertSafe(events: WorkbenchEventDraft[]): void {
    const serialized = JSON.stringify(events);
    for (const value of RUNNER_CONFORMANCE_UNSAFE_VALUES) {
        expect(serialized).not.toContain(value);
    }
}

function text(events: WorkbenchEventDraft[]) {
    return events
        .filter((event) => event.type === 'output.text')
        .map((event) => event.data.text)
        .join('');
}
