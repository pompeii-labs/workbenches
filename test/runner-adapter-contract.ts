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
import {
    activateModelCatalogFixture,
    modelCatalogFixture,
} from './model-catalog-fixture.js';

activateModelCatalogFixture();

export const RUNNER_CONFORMANCE_UNSAFE_VALUES = [
    'MUST_NOT_RENDER_REASONING',
    'MUST_NOT_RENDER_CREDENTIAL',
    'MUST_NOT_RENDER_COMMAND_SECRET',
    'MUST_NOT_RENDER_IMAGE_DATA',
] as const;

/**
 * The shell call every runner fixture makes in the tool events scenario. Its
 * credential must never cross the event boundary; its structure must.
 */
export const RUNNER_CONFORMANCE_SHELL_COMMAND = `API_TOKEN=${RUNNER_CONFORMANCE_UNSAFE_VALUES[2]} npx tgcheck --json`;

/** What the tool events scenario's write and shell call return. */
export const RUNNER_CONFORMANCE_TOOL_OUTPUT = {
    write: 'Wrote output.txt',
    shell: 'tgcheck: 3 checks passed',
} as const;

/**
 * A credential the host passes into the session environment under a
 * credential name. It matches no recognizable key format, so only exact-value
 * redaction removes it.
 */
export const RUNNER_CONFORMANCE_INJECTED_CREDENTIAL = 'conformance-injected-value-xq';

/** A credential that only its name, or the name of the field holding it, gives away. */
export const RUNNER_CONFORMANCE_NAMED_CREDENTIAL = 'conformance-named-value-zq';

/**
 * The shell call and edit every runner fixture makes in the tool details
 * scenario, each carrying both credentials into its input, output, and patch.
 */
export const RUNNER_CONFORMANCE_DETAILS = {
    shell: {
        id: 'call_details_shell',
        command: `API_TOKEN=${RUNNER_CONFORMANCE_NAMED_CREDENTIAL} ./deploy --check`,
        apiKey: RUNNER_CONFORMANCE_NAMED_CREDENTIAL,
        note: `uses ${RUNNER_CONFORMANCE_INJECTED_CREDENTIAL}`,
        output: `api_key=${RUNNER_CONFORMANCE_NAMED_CREDENTIAL}\nloaded ${RUNNER_CONFORMANCE_INJECTED_CREDENTIAL}\n`,
    },
    edit: {
        id: 'call_details_edit',
        path: '/workspace/config.txt',
        oldText: 'mode=draft\n',
        newText: `SERVICE_API_KEY=${RUNNER_CONFORMANCE_NAMED_CREDENTIAL}\nmode=${RUNNER_CONFORMANCE_INJECTED_CREDENTIAL}\n`,
        output: 'Edited config.txt',
    },
} as const;

const limitLines = (word: string) =>
    Array.from({ length: 4000 }, (_, index) => `${word} line ${index}\n`).join('');

/** The shell call and edit every runner fixture makes in the tool limits scenario, each over its cap. */
export const RUNNER_CONFORMANCE_LIMITS = {
    shell: {
        id: 'call_limits_shell',
        command: 'cat big.txt',
        content: 'x'.repeat(40_000),
        output: `${'h'.repeat(10_000)}${'m'.repeat(20_000)}${'t'.repeat(10_000)}`,
    },
    edit: {
        id: 'call_limits_edit',
        path: '/workspace/limits.txt',
        oldText: limitLines('old'),
        newText: limitLines('new'),
        output: 'Edited limits.txt',
    },
} as const;

/** The session environment every scenario starts with. */
const CONFORMANCE_ENVIRONMENT = {
    CONFORMANCE_API_KEY: RUNNER_CONFORMANCE_INJECTED_CREDENTIAL,
};

export type RunnerConformanceScenario =
    | 'streaming_text'
    | 'tool_events'
    | 'tool_details'
    | 'tool_limits'
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
                        data: expect.objectContaining({
                            id: 'call_contract',
                            name: 'write',
                            title: 'Write',
                            target: '/workspace/output.txt',
                        }),
                    });
                    expect(observed.events).toContainEqual({
                        type: 'tool.completed',
                        data: expect.objectContaining({
                            id: 'call_contract',
                            name: 'write',
                            title: 'Write',
                            target: '/workspace/output.txt',
                            status: 'completed',
                            input: expect.objectContaining({
                                content: 'contract output\n',
                            }),
                            output: RUNNER_CONFORMANCE_TOOL_OUTPUT.write,
                        }),
                    });
                    expect(observed.events).toContainEqual({
                        type: 'tool.completed',
                        data: expect.objectContaining({
                            id: 'call_shell',
                            target: 'API_TOKEN=[REDACTED] npx tgcheck --json',
                            status: 'completed',
                            input: {
                                command: 'API_TOKEN=[REDACTED] npx tgcheck --json',
                            },
                            output: RUNNER_CONFORMANCE_TOOL_OUTPUT.shell,
                        }),
                    });
                }
                if (supported(options, 'file_events')) {
                    expect(observed.events).toContainEqual({
                        type: 'file.changed',
                        data: expect.objectContaining({
                            path: '/workspace/output.txt',
                            operation: 'write',
                        }),
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

        test('reports tool input, output, and patch with every credential redacted', async () => {
            if (
                !supported(options, 'tool_events') ||
                !supported(options, 'file_events')
            ) {
                return;
            }
            const harness = options.createHarness();
            harness.arrange('tool_details');
            const observed = await start(harness);
            try {
                await observed.session.prompt('use tools with credentials');
                const shell = completed(
                    observed.events,
                    RUNNER_CONFORMANCE_DETAILS.shell.id
                );
                expect(shell.input).toEqual({
                    command: 'API_TOKEN=[REDACTED] ./deploy --check',
                    apiKey: '[REDACTED]',
                    note: 'uses [REDACTED]',
                });
                expect(shell.output).toBe('api_key=[REDACTED]\nloaded [REDACTED]\n');

                const edit = completed(
                    observed.events,
                    RUNNER_CONFORMANCE_DETAILS.edit.id
                );
                expect(edit.output).toBe(RUNNER_CONFORMANCE_DETAILS.edit.output);
                expect(JSON.stringify(edit.input)).toContain('[REDACTED]');

                const change = changed(
                    observed.events,
                    RUNNER_CONFORMANCE_DETAILS.edit.path
                );
                expect(change).toEqual({
                    path: RUNNER_CONFORMANCE_DETAILS.edit.path,
                    operation: 'edit',
                    patch: '--- a/config.txt\n+++ b/config.txt\n@@ -1,1 +1,2 @@\n-mode=draft\n+SERVICE_API_KEY=[REDACTED]\n+mode=[REDACTED]\n',
                    additions: 2,
                    deletions: 1,
                });

                const serialized = JSON.stringify(observed.events);
                expect(serialized).not.toContain(RUNNER_CONFORMANCE_NAMED_CREDENTIAL);
                expect(serialized).not.toContain(
                    RUNNER_CONFORMANCE_INJECTED_CREDENTIAL
                );
                assertSafe(observed.events);
            } finally {
                await observed.session.close();
            }
        });

        test('bounds tool input, output, and patch and flags each truncation', async () => {
            if (
                !supported(options, 'tool_events') ||
                !supported(options, 'file_events')
            ) {
                return;
            }
            const harness = options.createHarness();
            harness.arrange('tool_limits');
            const observed = await start(harness);
            try {
                await observed.session.prompt('use tools with large data');
                const shell = completed(
                    observed.events,
                    RUNNER_CONFORMANCE_LIMITS.shell.id
                );
                expect(shell.input_truncated).toBe(true);
                expect(bytes(JSON.stringify(shell.input))).toBeLessThanOrEqual(16_384);
                expect(String(record(shell.input).content)).toMatch(
                    /^x+…\[\d+ bytes truncated\]$/u
                );
                expect(record(shell.input).command).toBe(
                    RUNNER_CONFORMANCE_LIMITS.shell.command
                );
                expect(shell.output_truncated).toBe(true);
                expect(shell.output).toBe(
                    `${'h'.repeat(8192)}\n…[23616 bytes truncated]…\n${'t'.repeat(8192)}`
                );

                const change = changed(
                    observed.events,
                    RUNNER_CONFORMANCE_LIMITS.edit.path
                );
                expect(change.patch_truncated).toBe(true);
                expect(bytes(String(change.patch))).toBeLessThanOrEqual(65_536);
                expect(String(change.patch)).toStartWith(
                    '--- a/limits.txt\n+++ b/limits.txt\n@@ '
                );
                expect(change.additions).toBe(4000);
                expect(change.deletions).toBe(4000);
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
                            data: RUNNER_CONFORMANCE_UNSAFE_VALUES[3],
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
        environment: { ...CONFORMANCE_ENVIRONMENT },
        configuration: new ModelRouter(modelCatalogFixture).resolve({
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
    for (const value of [
        ...RUNNER_CONFORMANCE_UNSAFE_VALUES,
        RUNNER_CONFORMANCE_INJECTED_CREDENTIAL,
    ]) {
        expect(serialized).not.toContain(value);
    }
}

/** The data of the one `tool.completed` event for call `id`. */
function completed(events: WorkbenchEventDraft[], id: string): Record<string, unknown> {
    const matches = events.filter(
        (event) => event.type === 'tool.completed' && event.data.id === id
    );
    expect(matches).toHaveLength(1);
    return matches[0]?.data ?? {};
}

/** The data of the one `file.changed` event for `path`. */
function changed(events: WorkbenchEventDraft[], path: string): Record<string, unknown> {
    const matches = events.filter(
        (event) => event.type === 'file.changed' && event.data.path === path
    );
    expect(matches).toHaveLength(1);
    return matches[0]?.data ?? {};
}

function record(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value))
        : {};
}

function bytes(text: string): number {
    return new TextEncoder().encode(text).length;
}

function text(events: WorkbenchEventDraft[]) {
    return events
        .filter((event) => event.type === 'output.text')
        .map((event) => event.data.text)
        .join('');
}
