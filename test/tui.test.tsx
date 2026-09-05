import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { InputRenderable, Renderable, TextareaRenderable } from '@opentui/core';
import { testRender } from '@opentui/solid';

import type { CatalogEntry } from '../src/catalog/index.js';
import type { RunnerInput } from '../src/runners/session.js';
import type {
    RunControlDisposition,
    RunControlKind,
    RunControlReceipt,
    RunHandle,
    WorkbenchEvent,
} from '../src/runs/index.js';
import { SessionStore, type StoredSession } from '../src/sessions/index.js';
import { Transcript, WorkbenchApp } from '../src/tui/app.js';
import { TurnCancellation } from '../src/tui/chat.js';
import { holdRendererUntilShutdown } from '../src/tui/lifecycle.js';
import { QuestionPrompt } from '../src/tui/question.js';
import { SessionTranscript } from '../src/tui/session-transcript.js';
import { ThemeController, ThemeProvider } from '../src/tui/theme/index.js';
import type { ResolvedWorkbenchReference } from '../src/workbench/index.js';

const renderers: Array<{ destroy(): void }> = [];
const temporaryDirectories: string[] = [];
const themes = new ThemeController('/tmp/workbench-tui-tests');
let fakeHandleSequence = 0;

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

    test('renders the launchpad with recent activity and saved Workbench details', async () => {
        const setup = await testRender(
            () => (
                <ThemeProvider controller={themes}>
                    <WorkbenchApp
                        home="/tmp/workbench-tui-tests"
                        entries={[entry('lux-core'), entry('lux-migrations')]}
                        recentSessions={[recentSession('lux-core')]}
                        resolve={async (alias) => homeWorkbench(alias)}
                        start={async () => {
                            throw new Error('not started in this test');
                        }}
                    />
                </ThemeProvider>
            ),
            { width: 100, height: 28 }
        );
        renderers.push(setup.renderer);
        await Bun.sleep(10);
        await setup.flush();

        const initial = setup.captureCharFrame();
        expect(initial).toContain('◆ WORKBENCH');
        expect(initial).toContain('Your saved expert environments.');
        expect(initial).toContain('RECENT SESSIONS');
        expect(initial).toContain('resume');
        expect(initial).toContain('lux-core');
        expect(initial).toContain('lux-migrations');
        expect(initial).toContain('Maintain Lux applications with trusted patterns.');
        expect(initial).toContain('opencode · openai/gpt-5.4-mini');
        expect(initial).toContain('1 skill · 1 tool · 1 MCP');
        expect(initial).toContain('SAVED WORKBENCHES');
        expect(initial).toContain('ctrl+r resume latest');
    });

    test('keeps the home launchpad useful in a narrow terminal', async () => {
        const setup = await testRender(
            () => (
                <ThemeProvider controller={themes}>
                    <WorkbenchApp
                        home="/tmp/workbench-tui-tests"
                        entries={[entry('lux-core'), entry('lux-migrations')]}
                        recentSessions={[recentSession('lux-core')]}
                        resolve={async (alias) => homeWorkbench(alias)}
                        start={async () => {
                            throw new Error('not started in this test');
                        }}
                    />
                </ThemeProvider>
            ),
            { width: 72, height: 24 }
        );
        renderers.push(setup.renderer);
        await Bun.sleep(10);
        await setup.flush();

        const frame = setup.captureCharFrame();
        expect(frame).toContain('◆ WORKBENCH');
        expect(frame).toContain('RECENT SESSIONS');
        expect(frame).toContain('lux-migrations');
        expect(frame).toContain('Maintain Lux applications with trusted patterns.');
        expect(frame).toContain('local runtime');
        expect(frame).toContain('1 OF 2 · ↓ MORE');
        expect(frame).not.toContain('PACKAGE');
    });

    test('filters saved Workbenches and opens the selected result', async () => {
        const setup = await testRender(
            () => (
                <ThemeProvider controller={themes}>
                    <WorkbenchApp
                        home="/tmp/workbench-tui-tests"
                        entries={[entry('lux-core'), entry('lux-migrations')]}
                        resolve={async (alias) => homeWorkbench(alias)}
                        start={async () => fakeHandle(() => {})}
                    />
                </ThemeProvider>
            ),
            { width: 100, height: 28 }
        );
        renderers.push(setup.renderer);
        await setup.mockInput.typeText('migrations');
        await Bun.sleep(10);
        await setup.flush();

        let frame = setup.captureCharFrame();
        expect(frame).toContain('lux-migrations');
        expect(frame).not.toContain('lux-db/lux#core');

        findInput(setup.renderer.root, 'home-search').submit();
        await Bun.sleep(10);
        await setup.flush();
        frame = setup.captureCharFrame();
        expect(frame).toContain('lux-migrations · lux-migrations');
        expect(frame).toContain('opencode · openai/gpt-5.4-mini · local');
    });

    test('keeps keyboard selection visible while scrolling the saved list', async () => {
        const entries = ['one', 'two', 'three', 'four', 'five'].map(entry);
        const setup = await testRender(
            () => (
                <ThemeProvider controller={themes}>
                    <WorkbenchApp
                        home="/tmp/workbench-tui-tests"
                        entries={entries}
                        resolve={async (alias) => homeWorkbench(alias)}
                        start={async () => fakeHandle(() => {})}
                    />
                </ThemeProvider>
            ),
            { width: 72, height: 24 }
        );
        renderers.push(setup.renderer);
        await setup.flush();
        for (let index = 0; index < 4; index += 1) {
            setup.mockInput.pressArrow('down');
            await setup.flush();
        }
        await Bun.sleep(10);
        await setup.flush();

        const frame = setup.captureCharFrame();
        expect(frame).toContain('◆ five');
        expect(frame).toContain('lux-db/lux#five');
        expect(frame).toContain('5 OF 5 · ↑ MORE');
    });

    test('does not accept input until the runner reports ready', async () => {
        const ready = deferred<void>();
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
                        start={async () =>
                            handleAwaitingReady(ready.promise, () => sent++)
                        }
                    />
                </ThemeProvider>
            ),
            { width: 100, height: 28 }
        );
        renderers.push(setup.renderer);
        await setup.flush();

        const prompt = findPrompt(setup.renderer.root);
        expect(setup.captureCharFrame()).toContain('Connecting to Workbench...');
        expect(setup.captureCharFrame()).not.toContain('Ready when you are.');
        prompt.setText('do not send yet');
        prompt.submit();
        await setup.flush();
        expect(sent).toBe(0);

        ready.resolve();
        await Bun.sleep(10);
        await setup.flush();
        expect(setup.captureCharFrame()).not.toContain('Connecting to Workbench...');
        expect(setup.captureCharFrame()).toContain('Ready when you are.');
        prompt.submit();
        await setup.flush();
        expect(sent).toBe(1);
    });

    test('restores input readiness after reattaching beyond the ready event', async () => {
        const home = await mkdtemp(join(tmpdir(), 'workbench-tui-reattach-'));
        temporaryDirectories.push(home);
        const id = 'wb_reattachcursor1234567890';
        const handle = fakeHandle(() => {});
        const session = await new SessionStore(home).create({
            id,
            workbench: 'workbench-creator',
            workbench_version: '0.1.3',
            runner: 'opencode',
            model: 'openai/gpt-5.6-terra',
            reference: 'creator',
            workbench_path: '/repo/.workbenches/creator',
            workspace: '/workspace/project',
            workspaces: [],
            native_session_id: 'ses_native_reattach',
            latest_run_id: handle.runId,
        });
        const transcript = new SessionTranscript(home, id);
        transcript.schedule([], { runId: handle.runId, sequence: 2 });
        await transcript.flush();
        const setup = await testRender(
            () => (
                <ThemeProvider controller={themes}>
                    <WorkbenchApp
                        home={home}
                        entries={[]}
                        initial={{
                            alias: 'creator',
                            session,
                            resolved: resolvedWorkbench('creator', 'opencode'),
                        }}
                        resolve={async () => {
                            throw new Error('not opened in this test');
                        }}
                        start={async () => ({
                            ...handle,
                            observe: () =>
                                (async function* () {
                                    await new Promise<never>(() => {});
                                })(),
                        })}
                    />
                </ThemeProvider>
            ),
            { width: 100, height: 28 }
        );
        renderers.push(setup.renderer);
        await Bun.sleep(10);
        await setup.flush();

        expect(setup.captureCharFrame()).toContain('Ready when you are.');
        expect(setup.captureCharFrame()).not.toContain('Connecting to Workbench...');
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

        setup.mockInput.pressEnter();
        await Bun.sleep(5);
        await setup.flush();
        expect(setup.captureCharFrame()).not.toContain('Themes');
        expect(findPrompt(setup.renderer.root).isDestroyed).toBeFalse();
    });

    test('keeps slash command names and titles on one readable row', async () => {
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
                        start={async () => fakeHandle(() => {})}
                    />
                </ThemeProvider>
            ),
            { width: 100, height: 32 }
        );
        renderers.push(setup.renderer);
        await Bun.sleep(10);
        await setup.flush();

        findPrompt(setup.renderer.root).setText('/');
        await setup.flush();
        const lines = setup.captureCharFrame().split('\n');

        expect(
            lines.some(
                (line) =>
                    line.includes('/permissions') &&
                    line.includes('Runner capabilities')
            )
        ).toBeTrue();
        expect(
            lines.some(
                (line) => line.includes('/clear') && line.includes('Clear transcript')
            )
        ).toBeTrue();
    });

    test('previews themes while navigating and restores an unconfirmed choice', async () => {
        const home = await mkdtemp(join(tmpdir(), 'workbench-tui-theme-'));
        temporaryDirectories.push(home);
        const controller = new ThemeController(home);
        const setup = await testRender(
            () => (
                <ThemeProvider controller={controller}>
                    <WorkbenchApp
                        home={home}
                        entries={[]}
                        initial={{
                            alias: 'creator',
                            resolved: resolvedWorkbench('creator', 'opencode'),
                        }}
                        resolve={async () => {
                            throw new Error('not opened in this test');
                        }}
                        start={async () => fakeHandle(() => {})}
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
        prompt.submit();
        await setup.flush();
        expect(controller.selected).toBe('workbench');

        setup.mockInput.pressArrow('down');
        await setup.flush();
        expect(controller.selected).toBe('flexoki');

        setup.mockInput.pressEscape();
        await Bun.sleep(100);
        await setup.flush();
        expect(setup.captureCharFrame()).not.toContain('Themes');
        expect(controller.selected).toBe('workbench');

        findPrompt(setup.renderer.root).setText('/theme');
        findPrompt(setup.renderer.root).submit();
        await setup.flush();
        setup.mockInput.pressArrow('down');
        setup.mockInput.pressEnter();
        await Bun.sleep(5);
        await setup.flush();
        expect(controller.selected).toBe('flexoki');
    });

    test('lists and resumes a native interactive session', async () => {
        const home = await mkdtemp(join(tmpdir(), 'workbench-tui-sessions-'));
        temporaryDirectories.push(home);
        const store = new SessionStore(home);
        const session = await store.create({
            id: 'wb_sessionbrowser1234567890',
            workbench: 'workbench-creator',
            workbench_version: '0.1.3',
            runner: 'opencode',
            model: 'openai/gpt-5.6-terra',
            reference: 'creator',
            workbench_path: '/repo/.workbenches/creator',
            workspace: '/workspace/project',
            workspaces: [],
            native_session_id: 'ses_native_1',
            latest_run_id: 'wb_sessionbrowser1234567890',
        });
        let resumed: StoredSession | undefined;
        const setup = await testRender(
            () => (
                <ThemeProvider controller={themes}>
                    <WorkbenchApp
                        home={home}
                        entries={[]}
                        initial={{
                            alias: 'creator',
                            resolved: resolvedWorkbench('creator', 'opencode'),
                        }}
                        resolve={async () => {
                            throw new Error('not opened in this test');
                        }}
                        resolveSession={async () => ({
                            alias: 'creator-resumed',
                            session,
                            resolved: resolvedWorkbench(
                                'workbench-creator',
                                'opencode'
                            ),
                        })}
                        start={async ({ session: target }) => {
                            if (target) resumed = target;
                            return fakeHandle(() => {});
                        }}
                    />
                </ThemeProvider>
            ),
            { width: 100, height: 32 }
        );
        renderers.push(setup.renderer);
        await Bun.sleep(10);
        await setup.flush();

        const prompt = findPrompt(setup.renderer.root);
        prompt.setText('/sessions');
        prompt.submit();
        await Bun.sleep(10);
        await setup.flush();
        let frame = setup.captureCharFrame();
        expect(frame).toContain('workbench-creator@0.1.3');
        expect(frame).toContain('opencode');
        expect(frame).toContain(session.id);

        setup.mockInput.pressEnter();
        await Bun.sleep(20);
        await setup.flush();
        frame = setup.captureCharFrame();
        expect(resumed?.id).toBe(session.id);
        expect(frame).toContain('creator-resumed · workbench-creator');
    });

    test('renders active runner state inside the transcript', async () => {
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
                        start={async () =>
                            fakeHandle(() => {}, event(1, 'turn.started', { index: 1 }))
                        }
                    />
                </ThemeProvider>
            ),
            { width: 100, height: 32 }
        );
        renderers.push(setup.renderer);
        await Bun.sleep(20);
        await setup.flush();

        const firstFrame = setup.captureCharFrame();
        expect(firstFrame).toContain('Thinking');
        expect(firstFrame).not.toContain('✦ Thinking');

        await Bun.sleep(100);
        await setup.flush();
        const secondFrame = setup.captureCharFrame();
        expect(secondFrame).toContain('Thinking');
        expect(secondFrame).not.toBe(firstFrame);
    });

    test('shows an interrupted turn before runner cancellation settles', async () => {
        const cancellation = deferred<RunControlReceipt>();
        let cancelCalls = 0;
        const handle = fakeHandle(() => {}, event(1, 'turn.started', { index: 1 }));
        handle.cancelTurn = () => {
            cancelCalls += 1;
            return cancellation.promise;
        };
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
                        start={async () => handle}
                    />
                </ThemeProvider>
            ),
            { width: 100, height: 32, exitOnCtrlC: false }
        );
        renderers.push(setup.renderer);
        await Bun.sleep(20);
        await setup.flush();
        expect(setup.captureCharFrame()).toContain('Thinking');

        setup.mockInput.pressCtrlC();
        await Bun.sleep(0);
        await setup.flush();

        const interrupted = setup.captureCharFrame();
        expect(cancelCalls).toBe(1);
        expect(interrupted).toContain('Turn interrupted');
        expect(interrupted).not.toContain('Thinking');

        cancellation.resolve(receipt('cancel_turn', 'cancelled'));
    });

    test('detaches the terminal client without closing the durable session', async () => {
        const handle = fakeHandle(() => {});
        let detaches = 0;
        let closes = 0;
        handle.detach = async () => {
            detaches += 1;
            return receipt('detach_client', 'detached');
        };
        handle.close = async () => {
            closes += 1;
            return receipt('close', 'closed');
        };
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
                        start={async () => handle}
                    />
                </ThemeProvider>
            ),
            { width: 100, height: 32, exitOnCtrlC: false }
        );
        renderers.push(setup.renderer);
        await Bun.sleep(20);
        await setup.flush();

        setup.mockInput.pressCtrlC();
        await Bun.sleep(20);

        expect(detaches).toBe(1);
        expect(closes).toBe(0);
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

    test('inspects and clears staged image attachments with a local command', async () => {
        const workspace = await mkdtemp(join(tmpdir(), 'workbench-tui-images-'));
        temporaryDirectories.push(workspace);
        const image = join(workspace, 'reference.png');
        await writeFile(image, Uint8Array.from([1, 2, 3]));
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
                        start={async () => fakeHandle(() => {})}
                    />
                </ThemeProvider>
            ),
            { width: 100, height: 32 }
        );
        renderers.push(setup.renderer);
        await Bun.sleep(10);
        await setup.flush();

        await setup.mockInput.pasteBracketedText(image);
        await setup.flush();
        let prompt = findPrompt(setup.renderer.root);
        prompt.setText('/attachments');
        prompt.submit();
        await setup.flush();

        let frame = setup.captureCharFrame();
        expect(frame).toContain('Attachments');
        expect(frame).toContain('reference.png');

        setup.mockInput.pressEscape();
        await setup.flush();
        prompt = findPrompt(setup.renderer.root);
        prompt.setText('/attachments clear');
        prompt.submit();
        await setup.flush();
        frame = setup.captureCharFrame();
        expect(frame).not.toContain('[image reference.png]');
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
                            assistantLabel="workbench-creator"
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
        expect(frame).toContain('workbench-creator');
        expect(frame).not.toContain('WORKBENCH');
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
                            assistantLabel="workbench-creator"
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

    test('renders every tool action and keeps failure details visible', async () => {
        const setup = await testRender(
            () => (
                <ThemeProvider controller={themes}>
                    <box width="100%" height="100%">
                        <Transcript
                            assistantLabel="workbench-creator"
                            item={{
                                id: 'activity-1',
                                kind: 'activity',
                                tools: [
                                    {
                                        id: 'tool-1',
                                        kind: 'tool',
                                        name: 'read',
                                        title: 'Read',
                                        target: '/repo/src/manifest.ts',
                                        description: 'lines 10-29',
                                        durationMs: 24,
                                        status: 'completed',
                                    },
                                    {
                                        id: 'tool-2',
                                        kind: 'tool',
                                        name: 'bash',
                                        title: 'Run tests',
                                        error: 'Process exited with status 1',
                                        status: 'failed',
                                    },
                                ],
                            }}
                            streaming={false}
                            workspace="/repo"
                        />
                    </box>
                </ThemeProvider>
            ),
            { width: 90, height: 12 }
        );
        renderers.push(setup.renderer);
        await setup.flush();

        const frame = setup.captureCharFrame();
        expect(frame).toContain('Read');
        expect(frame).toContain('src/manifest.ts');
        expect(frame).toContain('lines 10-29');
        expect(frame).toContain('24ms');
        expect(frame).toContain('Run tests');
        expect(frame).toContain('Process exited with status 1');
        expect(frame).not.toContain('2 actions');
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

function homeWorkbench(alias: string): ResolvedWorkbenchReference {
    const resolved = resolvedWorkbench(alias, 'opencode');
    resolved.workbench.manifest.description =
        'Maintain Lux applications with trusted patterns.';
    resolved.workbench.manifest.tools = ['lux'];
    resolved.workbench.manifest.mcps = [
        {
            name: 'lux-docs',
            transport: 'http',
            url: 'https://lux.dev/mcp',
            headers: {},
        },
    ];
    resolved.workbench.skills.push({
        name: 'lux-core',
        directory: '/tmp/lux-core',
        manifestPath: '/tmp/lux-core/SKILL.md',
    });
    return resolved;
}

function recentSession(workbench: string): StoredSession {
    return {
        version: 1,
        id: 'wb_homeactivity1234567890',
        workbench,
        workbench_version: '0.1.0',
        runner: 'opencode',
        model: 'openai/gpt-5.4-mini',
        reference: workbench,
        workbench_path: `/tmp/${workbench}`,
        workspace: '/tmp/workspace',
        workspaces: [],
        native_session_id: 'ses_home_activity',
        latest_run_id: 'wb_homeactivity1234567890',
        created_at: new Date(Date.now() - 60_000).toISOString(),
        updated_at: new Date(Date.now() - 30_000).toISOString(),
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

function fakeHandle(
    onSend: (input: RunnerInput) => void,
    ...events: WorkbenchEvent[]
): RunHandle {
    const control = async () => receipt('send', 'queued');
    fakeHandleSequence += 1;
    return {
        runId: `wb_tuitest${String(fakeHandleSequence).padStart(20, '0')}`,
        events: (async function* () {
            yield event(0, 'run.ready', {});
            for (const next of events) yield next;
        })(),
        observe: () =>
            (async function* () {
                yield event(0, 'run.ready', {});
                for (const next of events) yield next;
            })(),
        result: new Promise<never>(() => {}),
        attach: async () => receipt('attach_client', 'attached'),
        detach: async () => receipt('detach_client', 'detached'),
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

function handleAwaitingReady(
    ready: Promise<void>,
    onSend: (input: RunnerInput) => void
): RunHandle {
    const handle = fakeHandle(onSend);
    return {
        ...handle,
        events: (async function* () {
            await ready;
            yield event(0, 'run.ready', {});
        })(),
        observe: () =>
            (async function* () {
                await ready;
                yield event(0, 'run.ready', {});
            })(),
    };
}

function event(
    sequence: number,
    type: WorkbenchEvent['type'],
    data: unknown
): WorkbenchEvent {
    return {
        protocol: 0,
        run_id: 'wb_tui_test',
        sequence,
        timestamp: '2026-09-02T00:00:00.000Z',
        type,
        runner: 'opencode',
        data,
    };
}

function findPrompt(root: Renderable): TextareaRenderable {
    const prompt = findPromptOrUndefined(root);
    if (prompt) return prompt;
    throw new Error('Prompt textarea was not rendered');
}

function findInput(root: Renderable, id: string): InputRenderable {
    const input = root.findDescendantById(id);
    if (input) return input as InputRenderable;
    throw new Error(`Input was not rendered: ${id}`);
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
