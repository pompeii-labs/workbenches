import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Renderable, TextareaRenderable } from '@opentui/core';
import { testRender } from '@opentui/solid';

import type { CatalogEntry } from '../src/catalog/index.js';
import type { RunnerInput } from '../src/runners/session.js';
import type {
    RunControlDisposition,
    RunControlKind,
    RunControlReceipt,
    RunHandle,
} from '../src/runs/index.js';
import { Transcript, WorkbenchApp } from '../src/tui/app.js';
import { TurnCancellation } from '../src/tui/chat.js';
import { holdRendererUntilShutdown } from '../src/tui/lifecycle.js';
import { QuestionPrompt } from '../src/tui/question.js';
import { ThemeController, ThemeProvider } from '../src/tui/theme/index.js';
import type { ResolvedWorkbenchReference } from '../src/workbench/index.js';

const renderers: Array<{ destroy(): void }> = [];
const temporaryDirectories: string[] = [];
const themes = new ThemeController('/tmp/workbench-tui-tests');

afterEach(async () => {
    for (const renderer of renderers.splice(0)) renderer.destroy();
    await Promise.all(
        temporaryDirectories
            .splice(0)
            .map((directory) => rm(directory, { recursive: true, force: true }))
    );
});

describe.serial('Workbench TUI', () => {
    test('holds the CLI lifecycle until the renderer shuts down', async () => {
        let finish: () => void = () => {};
        const shutdown = new Promise<void>((resolve) => {
            finish = resolve;
        });
        let settled = false;
        const lifecycle = holdRendererUntilShutdown({
            mount: async () => {},
            shutdown,
            destroy: () => finish(),
        }).then(() => {
            settled = true;
        });

        await Bun.sleep(0);
        expect(settled).toBe(false);
        finish();
        await lifecycle;
        expect(settled).toBe(true);
    });

    test('shuts the renderer down when mounting fails', async () => {
        let destroyed = false;
        await expect(
            holdRendererUntilShutdown({
                mount: async () => {
                    throw new Error('mount failed');
                },
                shutdown: Promise.resolve(),
                destroy: () => {
                    destroyed = true;
                },
            })
        ).rejects.toThrow('mount failed');
        expect(destroyed).toBe(true);
    });

    test('renders the premium home with saved Workbench details', async () => {
        const setup = await testRender(
            () => (
                <ThemeProvider controller={themes}>
                    <WorkbenchApp
                        home="/tmp/workbench-tui-tests"
                        entries={[entry('lux-core'), entry('lux-migrations')]}
                        resolve={async () => {
                            throw new Error('not opened in this test');
                        }}
                        start={async () => {
                            throw new Error('not started in this test');
                        }}
                    />
                </ThemeProvider>
            ),
            { width: 100, height: 28 }
        );
        renderers.push(setup.renderer);
        await setup.flush();

        const initial = setup.captureCharFrame();
        expect(initial).toContain('◆ WORKBENCH');
        expect(initial).toContain('Expert systems, ready to run.');
        expect(initial).toContain('lux-core');
        expect(initial).toContain('lux-migrations');

        expect(initial).toContain('SAVED · 2');
        expect(initial).toContain('↑↓ navigate · enter open · esc quit');
    });

    test('renders the canonical model label in an interactive session header', async () => {
        const setup = await testRender(
            () => (
                <ThemeProvider controller={themes}>
                    <WorkbenchApp
                        home="/tmp/workbench-tui-tests"
                        entries={[]}
                        initial={{
                            alias: 'pi-smoke',
                            resolved: resolvedWorkbench('pi-smoke', 'pi'),
                        }}
                        resolve={async () => {
                            throw new Error('not opened in this test');
                        }}
                        start={async () => {
                            throw new Error('not started in this test');
                        }}
                    />
                </ThemeProvider>
            ),
            { width: 100, height: 28 }
        );
        renderers.push(setup.renderer);
        await setup.flush();

        const frame = setup.captureCharFrame();
        expect(frame).toContain('pi · openai/gpt-5.4-mini · local');
    });

    test('opens local slash commands without sending them to the runner', async () => {
        let sent = 0;
        const setup = await testRender(
            () => (
                <ThemeProvider controller={themes}>
                    <WorkbenchApp
                        home="/tmp/workbench-tui-tests"
                        entries={[]}
                        initial={{
                            alias: 'creator',
                            resolved: resolvedWorkbench('creator', 'opencode'),
                        }}
                        resolve={async () => {
                            throw new Error('not opened in this test');
                        }}
                        start={async () => fakeHandle(() => sent++)}
                    />
                </ThemeProvider>
            ),
            { width: 100, height: 32 }
        );
        renderers.push(setup.renderer);
        await Bun.sleep(10);
        await setup.flush();

        const prompt = findPrompt(setup.renderer.root);
        prompt.setText('/theme');
        await setup.flush();
        expect(setup.captureCharFrame()).toContain('/theme');

        prompt.submit();
        await setup.flush();
        expect(setup.captureCharFrame()).toContain('Themes');
        expect(setup.captureCharFrame()).toContain('Flexoki');
        expect(sent).toBe(0);
    });

    test('turns a dragged image path into a transient prompt attachment', async () => {
        const workspace = await mkdtemp(join(tmpdir(), 'workbench-tui-drop-'));
        temporaryDirectories.push(workspace);
        const image = join(workspace, 'reference image.png');
        await writeFile(image, Uint8Array.from([1, 2, 3]));
        let submitted: RunnerInput | undefined;
        const setup = await testRender(
            () => (
                <ThemeProvider controller={themes}>
                    <WorkbenchApp
                        home="/tmp/workbench-tui-tests"
                        entries={[]}
                        initial={{
                            alias: 'creator',
                            resolved: resolvedWorkbench(
                                'creator',
                                'opencode',
                                workspace
                            ),
                        }}
                        resolve={async () => {
                            throw new Error('not opened in this test');
                        }}
                        start={async () =>
                            fakeHandle((input) => {
                                submitted = input;
                            })
                        }
                    />
                </ThemeProvider>
            ),
            { width: 100, height: 32 }
        );
        renderers.push(setup.renderer);
        await Bun.sleep(10);
        await setup.flush();

        await setup.mockInput.pasteBracketedText(image.replaceAll(' ', '\\ '));
        await Bun.sleep(5);
        await setup.flush();

        expect(setup.captureCharFrame()).toContain('[image reference image.png]');
        const prompt = findPrompt(setup.renderer.root);
        expect(prompt.plainText).toBe('');
        prompt.setText('Inspect this image');
        prompt.submit();
        await setup.flush();

        expect(submitted).toEqual({
            text: 'Inspect this image',
            images: [
                {
                    name: 'reference image.png',
                    mimeType: 'image/png',
                    data: 'AQID',
                },
            ],
        });
    });

    test('coalesces repeated cancellation requests while one is pending', async () => {
        let cancelCalls = 0;
        const cancellation = deferred<RunControlReceipt>();
        const session: Pick<RunHandle, 'cancelTurn'> = {
            cancelTurn: () => {
                cancelCalls += 1;
                return cancellation.promise;
            },
        };
        const controller = new TurnCancellation();

        const first = controller.request(session);
        const second = controller.request(session);
        expect(cancelCalls).toBe(1);
        expect(second).toBe(first);
        expect(controller.pending).toBeTrue();

        cancellation.resolve(receipt('cancel_turn', 'cancelled'));
        await Promise.all([first, second]);
        expect(controller.pending).toBeFalse();
    });

    test('renders streamed assistant Markdown as rich TUI content', async () => {
        const setup = await testRender(
            () => (
                <ThemeProvider controller={themes}>
                    <box width="100%" height="100%">
                        <Transcript
                            item={{
                                id: 'assistant-1',
                                kind: 'assistant',
                                text: '# Findings\n\nThis is **important**.\n\n- [x] Checked\n- [ ] Follow up\n\n| Area | State |\n|---|---|\n| Auth | Risk |\n\n```ts\nconst safe = true\n// - [x] remains source\n```',
                            }}
                            streaming={false}
                        />
                    </box>
                </ThemeProvider>
            ),
            { width: 100, height: 32 }
        );
        renderers.push(setup.renderer);
        let frame = setup.captureCharFrame();
        for (
            let attempt = 0;
            attempt < 200 && !frame.includes('Findings');
            attempt += 1
        ) {
            await Bun.sleep(10);
            await setup.renderOnce();
            frame = setup.captureCharFrame();
        }
        expect(frame).toContain('Findings');
        expect(frame).toContain('This is important.');
        expect(frame).toContain('Checked');
        expect(frame).toContain('Follow up');
        expect(frame).toContain('Area');
        expect(frame).toContain('Auth');
        expect(frame).toContain('const safe = true');
        expect(frame).toContain('// - [x] remains source');
        expect(frame).not.toContain('# Findings');
        expect(frame).not.toContain('[ ]');
        expect(frame).not.toContain('**important**');
        expect(frame).not.toContain('```');
        expect(frame).not.toContain('|---|---|');
    });

    test('uses a stable marker-free preview while assistant text is streaming', async () => {
        const setup = await testRender(
            () => (
                <ThemeProvider controller={themes}>
                    <box width="100%" height="100%">
                        <Transcript
                            item={{
                                id: 'assistant-streaming',
                                kind: 'assistant',
                                text: '# Findings\n\nThis is **important**.\n\n- [x] Checked\n- [ ] Follow up\n\n```ts\nconst safe = true\n```',
                            }}
                            streaming={true}
                        />
                    </box>
                </ThemeProvider>
            ),
            { width: 100, height: 24 }
        );
        renderers.push(setup.renderer);
        await setup.flush();

        const frame = setup.captureCharFrame();
        expect(frame).toContain('▌ Findings');
        expect(frame).toContain('This is important.');
        expect(frame).toContain('✓ Checked');
        expect(frame).toContain('○ Follow up');
        expect(frame).toContain('┌─ ts');
        expect(frame).toContain('const safe = true');
        expect(frame).not.toContain('# Findings');
        expect(frame).not.toContain('**important**');
        expect(frame).not.toContain('[x]');
        expect(frame).not.toContain('[ ]');
        expect(frame).not.toContain('```');
    });

    test('collapses successful tool activity while keeping failure details visible', async () => {
        const setup = await testRender(
            () => (
                <ThemeProvider controller={themes}>
                    <box width="100%" height="100%">
                        <Transcript
                            item={{
                                id: 'activity-1',
                                kind: 'activity',
                                tools: [
                                    {
                                        id: 'tool-1',
                                        kind: 'tool',
                                        title: 'Read manifest',
                                        status: 'completed',
                                    },
                                    {
                                        id: 'tool-2',
                                        kind: 'tool',
                                        title: 'Run tests',
                                        detail: 'Process exited with status 1',
                                        status: 'failed',
                                    },
                                ],
                            }}
                            streaming={false}
                        />
                    </box>
                </ThemeProvider>
            ),
            { width: 90, height: 12 }
        );
        renderers.push(setup.renderer);
        await setup.flush();

        const frame = setup.captureCharFrame();
        expect(frame).toContain('2 actions · 1 failed');
        expect(frame).toContain('Run tests: Process exited with status 1');
        expect(frame).not.toContain('Read manifest');
    });

    test('renders a normalized runner question with choices', async () => {
        const setup = await testRender(
            () => (
                <ThemeProvider controller={themes}>
                    <QuestionPrompt
                        request={{
                            id: 'question-1',
                            questions: [
                                {
                                    header: 'Environment',
                                    question: 'Where should this deploy?',
                                    options: [
                                        {
                                            label: 'Production',
                                            description: 'Deploy for customers',
                                        },
                                        {
                                            label: 'Staging',
                                            description: 'Test it first',
                                        },
                                    ],
                                    multiple: false,
                                    custom: false,
                                },
                            ],
                        }}
                        onRespond={() => {}}
                    />
                </ThemeProvider>
            ),
            { width: 80, height: 18 }
        );
        renderers.push(setup.renderer);
        await setup.flush();

        const frame = setup.captureCharFrame();
        expect(frame).toContain('? Environment');
        expect(frame).toContain('Where should this deploy?');
        expect(frame).toContain('Production');
        expect(frame).toContain('Deploy for customers');
    });
});

function entry(alias: string): CatalogEntry {
    return {
        alias,
        name: alias,
        version: '0.1.0',
        source: 'lux-db/lux',
        selector: alias.replace('lux-', ''),
        digest: `sha256:${'a'.repeat(64)}`,
        packagePath: `/tmp/${alias}`,
        addedAt: '2026-08-18T00:00:00.000Z',
        revision: '0123456789abcdef',
    };
}

function resolvedWorkbench(
    name: string,
    runner: string,
    workspaceDirectory = '/tmp/workspace'
): ResolvedWorkbenchReference {
    return {
        workspaceDirectory,
        cleanup: async () => {},
        workbench: {
            manifestPath: `/tmp/${name}/workbench.yml`,
            packageDirectory: `/tmp/${name}`,
            repositoryDirectory: '/tmp',
            instructionsPath: `/tmp/${name}/instructions.md`,
            skills: [],
            manifest: {
                spec: 0,
                version: '0.1.0',
                name,
                runner,
                model: { id: 'openai/gpt-5.4-mini' },
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

function receipt(
    kind: RunControlKind,
    disposition: RunControlDisposition
): RunControlReceipt {
    return {
        version: 1,
        id: crypto.randomUUID(),
        kind,
        outcome: 'accepted',
        resolved_at: '2026-09-01T00:00:00.000Z',
        disposition,
    };
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((accepted) => {
        resolve = accepted;
    });
    return { promise, resolve };
}

function fakeHandle(onSend: (input: RunnerInput) => void): RunHandle {
    const control = async () => receipt('send', 'queued');
    return {
        runId: 'wb_tui_test',
        events: (async function* () {
            yield {
                protocol: 0,
                run_id: 'wb_tui_test',
                sequence: 1,
                timestamp: '2026-09-02T00:00:00.000Z',
                type: 'run.ready',
                runner: 'opencode',
                data: {},
            };
        })(),
        result: new Promise(() => {}),
        send: async (input) => {
            onSend(input);
            return control();
        },
        steer: async (input) => {
            onSend(input);
            return control();
        },
        followUp: control,
        cancelTurn: () => control(),
        respondToPermission: () => control(),
        respondToQuestion: () => control(),
        close: () => control(),
        cancel: () => control(),
    };
}

function findPrompt(root: Renderable): TextareaRenderable {
    const prompt = findPromptOrUndefined(root);
    if (prompt) return prompt;
    throw new Error('Prompt textarea was not rendered');
}

function findPromptOrUndefined(root: Renderable): TextareaRenderable | undefined {
    for (const child of root.getChildren()) {
        const candidate = child as Renderable & { traits?: { status?: string } };
        if (candidate.traits?.status === 'PROMPT') {
            return child as TextareaRenderable;
        }
        const nested = findPromptOrUndefined(child);
        if (nested) return nested;
    }
    return undefined;
}
