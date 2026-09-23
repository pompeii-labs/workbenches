import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    type InputRenderable,
    type Renderable,
    type TextareaRenderable,
    TextRenderable,
} from '@opentui/core';
import { testRender } from '@opentui/solid';
import {
    AuthoringCreateIncompleteError,
    type AuthoringOperation,
    type AuthoringOperationResult,
} from '../src/authoring/index.js';
import type { CatalogEntry } from '../src/catalog/index.js';
import { OutcomeLifecycle } from '../src/outcomes/lifecycle.js';
import { OutcomeStore } from '../src/outcomes/store.js';
import type { RegistrySearchResult } from '../src/registry/index.js';
import type { RunnerInput } from '../src/runners/session.js';
import type {
    RunControlDisposition,
    RunControlKind,
    RunControlReceipt,
    RunHandle,
    WorkbenchEvent,
} from '../src/runs/index.js';
import { RunStore } from '../src/runs/store.js';
import { SessionStore, type StoredSession } from '../src/sessions/index.js';
import { Transcript, WorkbenchApp } from '../src/tui/app.js';
import { ChatHeader } from '../src/tui/chat-header.js';
import { holdRendererUntilShutdown } from '../src/tui/lifecycle.js';
import { QuestionPrompt } from '../src/tui/question.js';
import { TurnCancellation } from '../src/tui/session.js';
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

    test('renders a centered launcher without eagerly resolving packages', async () => {
        let resolved = 0;
        const setup = await testRender(
            () => (
                <ThemeProvider controller={themes}>
                    <WorkbenchApp
                        home="/tmp/workbench-tui-tests"
                        entries={[entry('lux-core'), entry('lux-migrations')]}
                        recentSessions={[recentSession('lux-core')]}
                        resolve={async (alias) => {
                            resolved += 1;
                            return homeWorkbench(alias);
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
        await Bun.sleep(10);
        await setup.flush();

        const initial = setup.captureCharFrame();
        expect(initial).toContain('█   █ █▀▀█ █▀▀▄ █ ▄▀');
        expect(initial).toContain('Search saved and published Workbenches');
        expect(initial).toContain('Search by publisher, name, or expertise');
        expect(initial).not.toContain('lux-core');
        expect(initial).not.toContain('RECENT SESSIONS');
        expect(resolved).toBe(0);
    });

    test('keeps launcher search useful in a narrow terminal', async () => {
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
        await setup.mockInput.typeText('lux');
        await Bun.sleep(10);
        await setup.flush();

        const frame = setup.captureCharFrame();
        expect(frame).toContain('█   █ █▀▀█ █▀▀▄ █ ▄▀');
        expect(frame).toContain('lux-core');
        expect(frame).toContain('lux-migrations');
        expect(frame).toContain('lux-db/lux#migrations');
        expect(frame).not.toContain('Maintain Lux applications');
    });

    test('uses compact branding when terminal color is unavailable', async () => {
        const setup = await testRender(
            () => (
                <ThemeProvider controller={themes}>
                    <WorkbenchApp
                        home="/tmp/workbench-tui-tests"
                        entries={[]}
                        plainBranding={true}
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
        await setup.flush();

        const frame = setup.captureCharFrame();
        expect(frame).toContain('◆ workbench');
        expect(frame).not.toContain('█   █ █▀▀█ █▀▀▄ █ ▄▀');
    });

    test('keeps a long named session header readable in a narrow terminal', async () => {
        const manifest = resolvedWorkbench('workbench-creator', 'opencode').workbench
            .manifest;
        const setup = await testRender(
            () => (
                <ThemeProvider controller={themes}>
                    <box width="100%" height="100%">
                        <ChatHeader
                            alias="creator"
                            sessionName={'Release review '.repeat(6)}
                            manifest={manifest}
                        />
                    </box>
                </ThemeProvider>
            ),
            { width: 72, height: 6 }
        );
        renderers.push(setup.renderer);
        await setup.flush();

        const frame = setup.captureCharFrame();
        expect(frame).toContain('Release review');
        expect(frame).toContain('…');
        expect(frame).not.toContain('openai/gpt-5.4-mini');
    });

    test('measures wide session names by terminal columns', async () => {
        const manifest = resolvedWorkbench('workbench-creator', 'opencode').workbench
            .manifest;
        const setup = await testRender(
            () => (
                <ThemeProvider controller={themes}>
                    <box width="100%" height="100%">
                        <ChatHeader
                            alias="creator"
                            sessionName={'界'.repeat(20)}
                            manifest={manifest}
                        />
                    </box>
                </ThemeProvider>
            ),
            { width: 24, height: 6 }
        );
        renderers.push(setup.renderer);
        await setup.flush();

        const frame = setup.captureCharFrame();
        expect(frame).toContain('界界界');
        expect(frame).toContain('…');
        expect(
            frame
                .split('\n')
                .every((line) => Bun.stringWidth(line.replaceAll(/\s+$/gu, '')) <= 24)
        ).toBe(true);
    });

    test('opens a fresh blank Workbench creator from the home screen', async () => {
        let created = 0;
        const prompts: RunnerInput[] = [];
        const setup = await testRender(
            () => (
                <ThemeProvider controller={themes}>
                    <WorkbenchApp
                        home="/tmp/workbench-tui-tests"
                        entries={[]}
                        resolve={async (alias) => homeWorkbench(alias)}
                        createWorkbench={async () => {
                            created += 1;
                            return {
                                alias: 'creator',
                                resolved: resolvedWorkbench(
                                    'workbench-creator',
                                    'opencode'
                                ),
                            };
                        }}
                        start={async () => fakeHandle((input) => prompts.push(input))}
                    />
                </ThemeProvider>
            ),
            { width: 100, height: 28 }
        );
        renderers.push(setup.renderer);

        setup.mockInput.pressKey('n', { ctrl: true });
        await Bun.sleep(10);
        await setup.flush();

        expect(created).toBe(1);
        expect(setup.captureCharFrame()).toContain('creator · workbench-creator');
        expect(setup.captureCharFrame()).toContain('Ready when you are.');
        expect(prompts).toEqual([]);
    });

    test('keeps create shortcut letters available to home search', async () => {
        let created = 0;
        const setup = await testRender(
            () => (
                <ThemeProvider controller={themes}>
                    <WorkbenchApp
                        home="/tmp/workbench-tui-tests"
                        entries={[entry('lux-core'), entry('lux-migrations')]}
                        resolve={async (alias) => homeWorkbench(alias)}
                        createWorkbench={async () => {
                            created += 1;
                            throw new Error('creation should not start');
                        }}
                        start={async () => fakeHandle(() => {})}
                    />
                </ThemeProvider>
            ),
            { width: 100, height: 28 }
        );
        renderers.push(setup.renderer);

        await setup.mockInput.typeText('core');
        await Bun.sleep(10);
        await setup.flush();

        const frame = setup.captureCharFrame();
        expect(created).toBe(0);
        expect(frame).toContain('core');
        expect(frame).toContain('lux-core');
        expect(frame).not.toContain('lux-migrations');
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

        findInput(setup.renderer.root, 'home-launcher').submit();
        await Bun.sleep(10);
        await setup.flush();
        expect(setup.captureCharFrame()).toContain('Launch Workbench');
        setup.mockInput.pressEnter();
        await setup.flush();
        frame = setup.captureCharFrame();
        expect(frame).toContain('◆ lux-migrations');
        expect(frame).toContain('opencode · openai/gpt-5.4-mini · local');
    });

    test('fuzzy-searches published Workbenches and saves one before opening it', async () => {
        const published = registryWorkbench('cloudflare', 'workers');
        const saved: RegistrySearchResult[] = [];
        const setup = await testRender(
            () => (
                <ThemeProvider controller={themes}>
                    <WorkbenchApp
                        home="/tmp/workbench-tui-tests"
                        entries={[entry('lux-core')]}
                        searchRegistry={async (query) => {
                            expect(query).toBe('clodflare');
                            return [published];
                        }}
                        saveRegistry={async (workbench) => {
                            saved.push(workbench);
                            return registryEntry(workbench);
                        }}
                        resolve={async (alias) => homeWorkbench(alias)}
                        start={async () => fakeHandle(() => {})}
                    />
                </ThemeProvider>
            ),
            { width: 100, height: 28 }
        );
        renderers.push(setup.renderer);
        await setup.mockInput.typeText('clodflare');
        await Bun.sleep(220);
        await setup.flush();

        let frame = setup.captureCharFrame();
        expect(frame).toContain('Cloudflare/workers');
        expect(frame).toContain('REGISTRY · 108 runs');
        expect(frame).toContain('Build production Cloudflare Workers');

        findInput(setup.renderer.root, 'home-launcher').submit();
        await Bun.sleep(10);
        await setup.flush();

        expect(saved).toEqual([published]);
        expect(setup.captureCharFrame()).toContain('Launch Workbench');
        setup.mockInput.pressEnter();
        await setup.flush();
        frame = setup.captureCharFrame();
        expect(frame).toContain('◆ workers');
        expect(frame).toContain('opencode · openai/gpt-5.4-mini · local');
    });

    test('does not match letters scattered across unrelated registry metadata', async () => {
        const setup = await testRender(
            () => (
                <ThemeProvider controller={themes}>
                    <WorkbenchApp
                        home="/tmp/workbench-tui-tests"
                        entries={[]}
                        searchRegistry={async () => [
                            registryWorkbench('cloudflare', 'workers'),
                            registryWorkbench('lux', 'durability'),
                        ]}
                        resolve={async (alias) => homeWorkbench(alias)}
                        start={async () => fakeHandle(() => {})}
                    />
                </ThemeProvider>
            ),
            { width: 100, height: 28 }
        );
        renderers.push(setup.renderer);
        await setup.mockInput.typeText('shalom');
        await Bun.sleep(220);
        await setup.flush();

        const frame = setup.captureCharFrame();
        expect(frame).not.toContain('Cloudflare/workers');
        expect(frame).not.toContain('lux-durability');
    });

    test('saves a highlighted registry result without opening it', async () => {
        const published = registryWorkbench('cloudflare', 'workers');
        let resolved = 0;
        const setup = await testRender(
            () => (
                <ThemeProvider controller={themes}>
                    <WorkbenchApp
                        home="/tmp/workbench-tui-tests"
                        entries={[]}
                        searchRegistry={async () => [published]}
                        saveRegistry={async (workbench) => registryEntry(workbench)}
                        resolve={async (alias) => {
                            resolved += 1;
                            return homeWorkbench(alias);
                        }}
                        start={async () => fakeHandle(() => {})}
                    />
                </ThemeProvider>
            ),
            { width: 100, height: 28 }
        );
        renderers.push(setup.renderer);
        await setup.mockInput.typeText('workers');
        await Bun.sleep(220);
        await setup.flush();
        setup.mockInput.pressArrow('down');
        setup.mockInput.pressKey('s');
        await Bun.sleep(10);
        await setup.flush();

        const frame = setup.captureCharFrame();
        expect(resolved).toBe(0);
        expect(frame).toContain('Saved cloudflare/workers as workers');
        expect(frame).toContain('SAVED · v1.2.0');
    });

    test('opens the keyboard-selected launcher result', async () => {
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
        await setup.mockInput.typeText('lux');
        await setup.flush();
        for (let index = 0; index < 5; index += 1) {
            setup.mockInput.pressArrow('down');
            await Bun.sleep(5);
            await setup.flush();
        }
        await Bun.sleep(10);
        await setup.flush();

        findInput(setup.renderer.root, 'home-launcher').submit();
        await Bun.sleep(10);
        await setup.flush();
        expect(setup.captureCharFrame()).toContain('Launch Workbench');
        setup.mockInput.pressEnter();
        await setup.flush();

        const frame = setup.captureCharFrame();
        expect(frame).toContain('◆ five');
        expect(frame).toContain('Ready when you are.');
    });

    test('finds and resumes a previous session from the home composer', async () => {
        const session = { ...recentSession('lux-core'), name: 'Release review' };
        const setup = await testRender(
            () => (
                <ThemeProvider controller={themes}>
                    <WorkbenchApp
                        home="/tmp/workbench-tui-tests"
                        entries={[entry('lux-core')]}
                        recentSessions={[session]}
                        resolve={async (alias) => homeWorkbench(alias)}
                        resolveSession={async () => ({
                            alias: 'lux-core',
                            resolved: homeWorkbench('lux-core'),
                            session,
                        })}
                        start={async () => fakeHandle(() => {})}
                    />
                </ThemeProvider>
            ),
            { width: 100, height: 28 }
        );
        renderers.push(setup.renderer);
        await setup.mockInput.typeText('/resume');
        await setup.flush();

        expect(setup.captureCharFrame()).toContain(
            'Find and continue a previous session'
        );
        findInput(setup.renderer.root, 'home-launcher').submit();
        await Bun.sleep(10);
        await setup.flush();

        let frame = setup.captureCharFrame();
        expect(frame).toContain('Resume a previous session');
        expect(frame).toContain('Release review');
        expect(frame).toContain('lux-core');
        findInput(setup.renderer.root, 'resume-search').submit();
        await Bun.sleep(10);
        await setup.flush();

        frame = setup.captureCharFrame();
        expect(frame).toContain('◆ Release review');
    });

    test('does not present a Workbench name as an unnamed session title', async () => {
        const session = recentSession('lux-core');
        const setup = await testRender(
            () => (
                <ThemeProvider controller={themes}>
                    <WorkbenchApp
                        home="/tmp/workbench-tui-tests"
                        entries={[entry('lux-core')]}
                        recentSessions={[session]}
                        resolve={async (alias) => homeWorkbench(alias)}
                        resolveSession={async () => ({
                            alias: 'lux-core',
                            resolved: homeWorkbench('lux-core'),
                            session,
                        })}
                        start={async () => fakeHandle(() => {})}
                    />
                </ThemeProvider>
            ),
            { width: 100, height: 28 }
        );
        renderers.push(setup.renderer);
        await setup.mockInput.typeText('/resume');
        await setup.flush();
        findInput(setup.renderer.root, 'home-launcher').submit();
        await Bun.sleep(10);
        await setup.flush();

        const frame = setup.captureCharFrame();
        expect(frame).toContain('Resume a previous session');
        expect(frame).toContain('Untitled session');
        expect(frame).toContain('lux-core');
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
        expect(setup.captureCharFrame()).toContain('Preparing local workspace...');
        expect(setup.captureCharFrame()).not.toContain('Ready when you are.');
        prompt.blur();
        await setup.mockInput.typeText('/');
        expect(prompt.focused).toBe(false);
        expect(prompt.plainText).toBe('');
        prompt.setText('do not send yet');
        prompt.submit();
        await setup.flush();
        expect(sent).toBe(0);

        ready.resolve();
        await Bun.sleep(10);
        await setup.flush();
        expect(setup.captureCharFrame()).not.toContain('Connecting to Workbench...');
        expect(setup.captureCharFrame()).toContain('Ready when you are.');
        expect(setup.captureCharFrame()).not.toContain('Preparing local workspace...');
        prompt.submit();
        await setup.flush();
        expect(sent).toBe(1);
    });

    test('accepts the first message as a new turn after startup reports ready', async () => {
        let sent = 0;
        let steered = 0;
        const handle = fakeHandle(() => sent++);
        const setup = await testRender(
            () => (
                <ThemeProvider controller={themes}>
                    <WorkbenchApp
                        home="/tmp/workbench-tui-tests"
                        entries={[]}
                        initial={{
                            alias: 'repo-engineer',
                            resolved: resolvedWorkbench('repo-engineer', 'opencode'),
                        }}
                        resolve={async () => {
                            throw new Error('not opened in this test');
                        }}
                        start={async () => ({
                            ...handle,
                            observe: () =>
                                (async function* () {
                                    yield event(0, 'run.started', {});
                                    yield event(1, 'run.ready', {});
                                })(),
                            steer: async () => {
                                steered++;
                                throw new Error('No active turn');
                            },
                        })}
                    />
                </ThemeProvider>
            ),
            { width: 100, height: 28 }
        );
        renderers.push(setup.renderer);
        await Bun.sleep(10);
        await setup.flush();

        const frame = setup.captureCharFrame();
        expect(frame).toContain('Ready when you are.');
        expect(frame).toContain('enter send');
        expect(frame).not.toContain('enter steer');

        const prompt = findPrompt(setup.renderer.root);
        prompt.setText('Read the repository');
        prompt.submit();
        await setup.flush();
        expect(sent).toBe(1);
        expect(steered).toBe(0);
    });

    for (const [runtime, runner, label] of [
        ['local', 'opencode', 'Preparing local workspace...'],
        ['local', 'pi', 'Preparing local workspace...'],
        ['docker', 'opencode', 'Starting Docker container...'],
        ['e2b', 'opencode', 'Starting E2B sandbox...'],
    ] as const) {
        test(`shows animated startup feedback while provisioning ${runner} on ${runtime}`, async () => {
            const starting = deferred<RunHandle>();
            const resolved = resolvedWorkbench('creator', runner);
            resolved.workbench.manifest.runtime = runtime;
            const setup = await testRender(
                () => (
                    <ThemeProvider controller={themes}>
                        <WorkbenchApp
                            home="/tmp/workbench-tui-tests"
                            entries={[]}
                            initial={{ alias: 'creator', resolved }}
                            resolve={async () => resolved}
                            start={() => starting.promise}
                        />
                    </ThemeProvider>
                ),
                { width: 100, height: 28 }
            );
            renderers.push(setup.renderer);
            await setup.flush();
            const first = setup.captureCharFrame();
            expect(first).toContain(label);
            expect(first).toContain('0s');
            expect(first).not.toContain('Ready when you are.');
            await Bun.sleep(100);
            await setup.flush();
            expect(setup.captureCharFrame()).not.toBe(first);
            if (runtime === 'e2b') {
                await Bun.sleep(1_000);
                await setup.flush();
                expect(setup.captureCharFrame()).toContain('1s');
            }
            starting.resolve(fakeHandle(() => {}));
            await Bun.sleep(10);
            await setup.flush();
            expect(setup.captureCharFrame()).not.toContain(label);
            expect(setup.captureCharFrame()).toContain('Ready when you are.');
        });
    }

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

    test('reattaches with canonical history after a cache was overwritten and continues streamed text once', async () => {
        const home = await mkdtemp(join(tmpdir(), 'workbench-tui-history-'));
        temporaryDirectories.push(home);
        const runs = new RunStore(home);
        const handle = fakeHandle(() => {});
        const stableId = 'wb_historyreattach123456789012';
        const session = await new SessionStore(home).create({
            ...recentSession('reports'),
            id: stableId,
            latest_run_id: handle.runId,
        });
        const metadata = {
            workbench: 'reports',
            workbench_version: '0.1.0',
            runner: 'opencode',
            model: 'openai/gpt-5.4-mini',
            runtime: 'e2b',
            workspace: '/workspace',
            session_id: stableId,
        };
        const request = {
            workbench_path: '/package',
            workspace: '/workspace',
            task: '',
        };
        const original = await runs.create({ metadata, request });
        await runs.update(original.id, {
            status: 'completed',
            dispatched_at: '2026-09-17T00:00:00.000Z',
        });
        await runs.create({ id: handle.runId, metadata, request });
        await runs.update(handle.runId, {
            status: 'running',
            dispatched_at: '2026-09-17T01:00:00.000Z',
        });
        for (const [runId, drafts] of [
            [
                original.id,
                [
                    event(1, 'run.ready', {}),
                    event(2, 'input.delivered', {
                        id: 'old-input',
                        kind: 'send',
                        text: 'Make the original report',
                    }),
                    event(3, 'output.text', {
                        id: 'old-reply',
                        text: 'Original report created',
                    }),
                ],
            ],
            [
                handle.runId,
                [
                    event(1, 'run.ready', {}),
                    event(2, 'input.delivered', {
                        id: 'new-input',
                        kind: 'send',
                        text: 'Revise that report',
                    }),
                    event(3, 'turn.started', {}),
                    event(4, 'output.text', { id: 'native-reply', text: 'Version ' }),
                ],
            ],
        ] as Array<[string, WorkbenchEvent[]]>) {
            for (const next of drafts)
                await runs.appendEvent(runId, { ...next, run_id: runId });
        }
        const cache = new SessionTranscript(home, stableId);
        cache.schedule(
            [
                {
                    id: 'error-2',
                    kind: 'notice',
                    tone: 'error',
                    text: 'OpenCode request failed with HTTP 404',
                },
            ],
            { runId: original.id, sequence: 3 }
        );
        await cache.flush();
        let afterSequence: number | undefined;
        const reattached: RunHandle = {
            ...handle,
            observe: (options) =>
                (async function* () {
                    afterSequence = options?.afterSequence;
                    yield {
                        ...event(5, 'output.text', { id: 'native-reply', text: 'two' }),
                        run_id: handle.runId,
                    };
                    await new Promise<never>(() => {});
                })(),
        };
        const setup = await testRender(
            () => (
                <ThemeProvider controller={themes}>
                    <WorkbenchApp
                        home={home}
                        entries={[]}
                        initial={{
                            alias: 'reports',
                            session,
                            resolved: resolvedWorkbench('reports', 'opencode'),
                        }}
                        resolve={async () => resolvedWorkbench('reports', 'opencode')}
                        start={async () => reattached}
                    />
                </ThemeProvider>
            ),
            { width: 100, height: 40 }
        );
        renderers.push(setup.renderer);
        const frame = await waitForFrame(
            setup,
            (current) =>
                current.includes('Original report created') &&
                current.includes('Version two'),
            'restored transcript replies'
        );
        expect(frame).toContain('Make the original report');
        expect(frame).toContain('Original report created');
        expect(frame).toContain('Revise that report');
        expect(frame).toContain('Version two');
        expect(frame).not.toContain('HTTP 404');
        expect(frame).not.toContain('Connecting to Workbench');
        expect(afterSequence).toBe(4);
        await Bun.sleep(150);
        const saved = await new SessionTranscript(home, stableId).load();
        expect(saved.filter((item) => item.kind === 'user')).toHaveLength(2);
        expect(saved.filter((item) => item.kind === 'assistant')).toHaveLength(2);
        expect(saved.find((item) => item.id === 'native-reply')).toMatchObject({
            text: 'Version two',
        });
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
        prompt.setText('/');
        await setup.flush();
        expect(setup.captureCharFrame()).not.toContain('/home');

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

    test('recovers composer focus with one slash without stealing dialog input', async () => {
        const resolved = resolvedWorkbench('creator', 'opencode');
        const setup = await testRender(
            () => (
                <ThemeProvider controller={themes}>
                    <WorkbenchApp
                        home="/tmp/workbench-tui-tests"
                        entries={[]}
                        initial={{ alias: 'creator', resolved }}
                        resolve={async () => resolved}
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
        prompt.blur();
        expect(prompt.focused).toBe(false);
        await setup.mockInput.typeText('/');
        await setup.flush();
        expect(prompt.focused, 'slash recovers a blurred prompt').toBe(true);
        expect(prompt.plainText).toBe('/');
        expect(setup.captureCharFrame()).toContain('/rename');

        prompt.setText('');
        await setup.mockInput.typeText('/');
        expect(prompt.plainText).toBe('/');

        prompt.setText('Keep this draft ');
        prompt.gotoBufferEnd();
        prompt.blur();
        await setup.mockInput.typeText('/');
        expect(prompt.plainText).toBe('Keep this draft /');
        expect(prompt.focused, 'slash preserves an existing draft').toBe(true);
        expect(setup.renderer.currentFocusedRenderable).toBe(prompt);

        prompt.setText('/help');
        prompt.submit();
        await setup.flush();
        expect(prompt.focused).toBe(false);
        await setup.mockInput.typeText('/');
        await setup.flush();
        expect(prompt.focused).toBe(false);
        expect(prompt.plainText).toBe('');
        setup.mockInput.pressEscape();
        await Bun.sleep(100);
        await setup.flush();
        expect(prompt.isDestroyed, 'closing the dialog keeps chat mounted').toBe(false);
        expect(setup.captureCharFrame()).not.toContain('Command palette');
        expect(prompt.focused, 'closing the dialog restores the prompt').toBe(true);
    });

    test('opens durable files and links from /outcome after the run finishes without a model turn', async () => {
        const home = await mkdtemp(join(tmpdir(), 'workbench-tui-outcome-'));
        temporaryDirectories.push(home);
        const store = new OutcomeStore(home);
        const content = await store.putBytes('original report', 'text/html');
        const outcome = await store.commit(
            {
                version: 1,
                id: OutcomeStore.createId(),
                run_id: 'wb_1234567890abcdefghij',
                created_at: new Date().toISOString(),
                completeness: 'complete',
                summary: 'Research finished',
                changesets: [],
                artifacts: [{ id: 'artifact_report', name: 'Report.html', content }],
                links: [
                    {
                        id: 'link_pr',
                        label: 'Pull request',
                        uri: 'https://example.com/pull/1',
                        kind: 'pull_request',
                    },
                ],
                warnings: [],
            },
            'pending'
        );
        await store.close();
        let sent = 0;
        const setup = await testRender(
            () => (
                <ThemeProvider controller={themes}>
                    <WorkbenchApp
                        home={home}
                        entries={[]}
                        initial={{
                            alias: 'probe',
                            resolved: resolvedWorkbench('probe', 'opencode'),
                        }}
                        resolve={async () => {
                            throw new Error('not opened');
                        }}
                        start={async () =>
                            fakeHandle(
                                () => sent++,
                                event(1, 'outcome.available', {
                                    outcome_id: outcome.id,
                                    completeness: 'complete',
                                    application_state: 'pending',
                                    changesets: 0,
                                    artifacts: 1,
                                    links: 1,
                                    warnings: 0,
                                }),
                                event(2, 'run.completed', { exit_code: 0 })
                            )
                        }
                    />
                </ThemeProvider>
            ),
            { width: 100, height: 36 }
        );
        renderers.push(setup.renderer);
        await Bun.sleep(20);
        await setup.flush();
        const prompt = findPrompt(setup.renderer.root);
        prompt.setText('/outcome');
        prompt.submit();
        const frame = await waitForFrame(
            setup,
            (current) =>
                current.includes('Run outcome') &&
                current.includes('Report.html') &&
                current.includes('Pull request'),
            'durable outcome details'
        );
        expect(frame).toContain('Run outcome');
        expect(frame).toContain('Report.html');
        expect(frame).toContain('Pull request');
        expect(frame).toContain('Apply explicitly');
        const links = renderedLinks(setup.renderer.root);
        const file = links.find((link) => link.text === 'Report.html');
        expect(file?.uri).toStartWith('file://');
        if (!file) throw new Error('Artifact hyperlink was not rendered');
        expect(await readFile(fileURLToPath(file.uri), 'utf8')).toBe('original report');
        expect(links.find((link) => link.text === 'Pull request')?.uri).toBe(
            'https://example.com/pull/1'
        );
        expect(sent).toBe(0);
    });

    test('opens live result links before session shutdown and preserves both revisions through replay', async () => {
        const home = await mkdtemp(join(tmpdir(), 'workbench-tui-live-results-'));
        temporaryDirectories.push(home);
        const lifecycle = await OutcomeLifecycle.create({
            home,
            runId: 'wb_1234567890abcdefghij',
        });
        const report = join(lifecycle.output.directory, 'Report.html');
        await writeFile(report, '<h1>First report</h1>');
        const first = await lifecycle.checkpoint(undefined, 1);
        await writeFile(report, '<h1>Revised report</h1>');
        const second = await lifecycle.checkpoint(undefined, 2);
        if (!first || !second) throw new Error('Missing fixture revisions');
        const next = deferred<void>();
        const done = deferred<void>();
        let sent = 0;
        const available = (sequence: number, id: string, turn: number) =>
            event(sequence, 'outcome.available', {
                outcome_id: id,
                completeness: 'partial',
                application_state: 'present',
                turn_index: turn,
                changesets: 0,
                artifacts: 1,
                links: 0,
                warnings: 0,
            });
        const handle = fakeHandle(() => sent++);
        handle.observe = () =>
            (async function* () {
                yield event(0, 'run.ready', {});
                yield available(1, first.id, 1);
                yield event(2, 'turn.completed', { index: 1 });
                await next.promise;
                yield available(3, second.id, 2);
                yield event(4, 'turn.completed', { index: 2 });
                await done.promise;
            })();
        const setup = await testRender(
            () => (
                <ThemeProvider controller={themes}>
                    <WorkbenchApp
                        home={home}
                        entries={[]}
                        initial={{
                            alias: 'probe',
                            resolved: resolvedWorkbench('probe', 'opencode'),
                        }}
                        resolve={async () => {
                            throw new Error('Not opened');
                        }}
                        start={async () => handle}
                    />
                </ThemeProvider>
            ),
            { width: 120, height: 40 }
        );
        renderers.push(setup.renderer);
        try {
            const waitForLinks = async (count: number) => {
                for (let attempt = 0; attempt < 200; attempt++) {
                    await Bun.sleep(5);
                    await setup.flush();
                    const links = renderedLinks(setup.renderer.root).filter(
                        (link) => link.text === 'Report.html'
                    );
                    if (links.length === count) return links;
                }
                throw new Error(`Expected ${count} live artifact links`);
            };
            const original = (await waitForLinks(1))[0];
            if (!original) throw new Error('Missing original link');
            expect(setup.captureCharFrame()).toContain('Results saved · turn 1');
            expect(setup.captureCharFrame()).not.toContain('Partial outcome available');
            expect(await readFile(fileURLToPath(original.uri), 'utf8')).toBe(
                '<h1>First report</h1>'
            );
            next.resolve();
            const links = await waitForLinks(2);
            expect(links.map((link) => link.uri)).toContain(original.uri);
            const revision = links.find((link) => link.uri !== original.uri);
            if (!revision) throw new Error('Missing revised link');
            expect(await readFile(fileURLToPath(revision.uri), 'utf8')).toBe(
                '<h1>Revised report</h1>'
            );
            expect(await readFile(fileURLToPath(original.uri), 'utf8')).toBe(
                '<h1>First report</h1>'
            );
            const prompt = findPrompt(setup.renderer.root);
            prompt.setText('/outcome');
            prompt.submit();
            for (
                let attempt = 0;
                attempt < 100 && !setup.captureCharFrame().includes('Results · turn 2');
                attempt++
            ) {
                await Bun.sleep(5);
                await setup.flush();
            }
            expect(setup.captureCharFrame()).toContain('Results · turn 2');
            expect(setup.captureCharFrame()).toContain('session can continue');
            expect(setup.captureCharFrame()).not.toContain('Apply explicitly');
            expect(sent).toBe(0);
            const transcript = new SessionTranscript(home, handle.runId);
            for (
                let attempt = 0;
                attempt < 100 &&
                (await transcript.load()).filter((item) => item.kind === 'outcome')
                    .length !== 2;
                attempt++
            )
                await Bun.sleep(5);
            const saved = (await transcript.load()).filter(
                (item) => item.kind === 'outcome'
            );
            expect(saved.map((item) => item.turnIndex)).toEqual([1, 2]);
            // Replay each saved card after its staging outbox has been removed.
            await lifecycle.cleanup();
            const replay = await testRender(
                () => (
                    <ThemeProvider controller={themes}>
                        <box flexDirection="column">
                            {saved.map((item) => (
                                <Transcript
                                    item={item}
                                    home={home}
                                    assistantLabel="probe"
                                    streaming={false}
                                />
                            ))}
                        </box>
                    </ThemeProvider>
                ),
                { width: 120, height: 30 }
            );
            renderers.push(replay.renderer);
            for (
                let attempt = 0;
                attempt < 200 && renderedLinks(replay.renderer.root).length !== 2;
                attempt++
            ) {
                await Bun.sleep(5);
                await replay.flush();
            }
            expect(renderedLinks(replay.renderer.root).map((link) => link.uri)).toEqual(
                links.map((link) => link.uri)
            );
        } finally {
            next.resolve();
            done.resolve();
            await lifecycle.cleanup();
        }
    });

    test('opens the creator from improve and submits the prepared evidence task', async () => {
        const home = await mkdtemp(join(tmpdir(), 'workbench-tui-improve-'));
        temporaryDirectories.push(home);
        const sent: Array<{ workbench: string; input: RunnerInput }> = [];
        let improvedSession = '';
        const setup = await testRender(
            () => (
                <ThemeProvider controller={themes}>
                    <WorkbenchApp
                        home={home}
                        entries={[]}
                        initial={{
                            alias: 'lux-ops',
                            resolved: resolvedWorkbench('lux-ops', 'opencode'),
                        }}
                        resolve={async () => {
                            throw new Error('not opened in this test');
                        }}
                        improveWorkbench={async (sessionId, feedback) => {
                            improvedSession = sessionId;
                            expect(feedback).toBe('teach the safe migration path');
                            return {
                                alias: 'creator',
                                resolved: resolvedWorkbench(
                                    'workbench-creator',
                                    'opencode'
                                ),
                                prompt: 'Read the prepared evidence and improve lux-ops.',
                            };
                        }}
                        start={async ({ resolved }) => {
                            const workbench = resolved.workbench.manifest.name;
                            return fakeHandle((input) =>
                                sent.push({ workbench, input })
                            );
                        }}
                    />
                </ThemeProvider>
            ),
            { width: 100, height: 32 }
        );
        renderers.push(setup.renderer);
        await Bun.sleep(10);
        await setup.flush();

        const original = findPrompt(setup.renderer.root);
        original.setText('/improve teach the safe migration path');
        original.submit();
        await Bun.sleep(30);
        await setup.flush();

        expect(improvedSession).toStartWith('wb_tuitest');
        expect(setup.captureCharFrame()).toContain('creator · workbench-creator');
        expect(sent).toEqual([
            {
                workbench: 'workbench-creator',
                input: 'Read the prepared evidence and improve lux-ops.',
            },
        ]);
    });

    test('verifies authoring before closing its creator session', async () => {
        let finishCalls = 0;
        let closeCalls = 0;
        let environment: Record<string, string | undefined> | undefined;
        let authoring = false;
        let completed: AuthoringOperationResult | undefined;
        const result: AuthoringOperationResult = {
            id: 'author_tui_finish',
            kind: 'improve',
            status: 'completed',
            packages: ['lux-ops'],
            changedFiles: ['.workbenches/lux-ops/instructions.md'],
        };
        const operation = {
            id: result.id,
            finish: async () => {
                finishCalls += 1;
                return result;
            },
            fail: async () => result,
        } as unknown as AuthoringOperation;
        const handle = fakeHandle(() => {});
        handle.close = async () => {
            closeCalls += 1;
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
                            resolved: resolvedWorkbench(
                                'workbench-creator',
                                'opencode'
                            ),
                            operation,
                            environment: { PATH: '/exact-authoring-cli' },
                        }}
                        resolve={async () => {
                            throw new Error('not opened in this test');
                        }}
                        start={async (options) => {
                            environment = options.environment;
                            authoring = options.authoring ?? false;
                            return handle;
                        }}
                        onAuthoringFinished={(value) => {
                            completed = value;
                        }}
                    />
                </ThemeProvider>
            ),
            { width: 100, height: 28, exitOnCtrlC: false }
        );
        renderers.push(setup.renderer);
        await Bun.sleep(10);
        await setup.flush();

        setup.mockInput.pressCtrlC();
        await Bun.sleep(10);
        await setup.flush();

        expect(environment?.PATH).toBe('/exact-authoring-cli');
        expect(authoring).toBe(true);
        expect(finishCalls).toBe(1);
        expect(closeCalls).toBe(1);
        expect(completed).toEqual(result);
    });

    test('exits a create operation that has not created a Workbench', async () => {
        let failedWith: string | undefined;
        let closeCalls = 0;
        let completed: AuthoringOperationResult | undefined;
        const result: AuthoringOperationResult = {
            id: 'author_tui_empty_create',
            kind: 'create',
            status: 'failed',
            packages: [],
            changedFiles: [],
            error: 'Creator exited before creating a Workbench.',
        };
        const operation = {
            id: result.id,
            finish: async () => {
                throw new AuthoringCreateIncompleteError();
            },
            fail: async (message: string) => {
                failedWith = message;
                return result;
            },
        } as unknown as AuthoringOperation;
        const handle = fakeHandle(() => {});
        handle.close = async () => {
            closeCalls += 1;
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
                            resolved: resolvedWorkbench(
                                'workbench-creator',
                                'opencode'
                            ),
                            operation,
                        }}
                        resolve={async () => {
                            throw new Error('not opened in this test');
                        }}
                        start={async () => handle}
                        onAuthoringFinished={(value) => {
                            completed = value;
                        }}
                    />
                </ThemeProvider>
            ),
            { width: 100, height: 28, exitOnCtrlC: false }
        );
        renderers.push(setup.renderer);
        await Bun.sleep(10);
        await setup.flush();

        const prompt = findPrompt(setup.renderer.root);
        prompt.setText('/quit');
        prompt.submit();
        await Bun.sleep(10);
        await setup.flush();

        expect(failedWith).toBe('Creator exited before creating a Workbench.');
        expect(closeCalls).toBe(1);
        expect(completed).toEqual(result);
    });

    test('does not finalize authoring while the creator turn is active', async () => {
        let finishCalls = 0;
        let closeCalls = 0;
        const operation = {
            id: 'author_tui_busy',
            finish: async () => {
                finishCalls += 1;
                throw new Error('should not finish');
            },
            fail: async () => {
                throw new Error('should not fail');
            },
        } as unknown as AuthoringOperation;
        const handle = fakeHandle(() => {}, event(1, 'turn.started', { index: 1 }));
        handle.close = async () => {
            closeCalls += 1;
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
                            resolved: resolvedWorkbench(
                                'workbench-creator',
                                'opencode'
                            ),
                            operation,
                        }}
                        resolve={async () => {
                            throw new Error('not opened in this test');
                        }}
                        start={async () => handle}
                    />
                </ThemeProvider>
            ),
            { width: 100, height: 28, exitOnCtrlC: false }
        );
        renderers.push(setup.renderer);
        await Bun.sleep(10);
        await setup.flush();

        const prompt = findPrompt(setup.renderer.root);
        prompt.setText('/quit');
        prompt.submit();
        await Bun.sleep(10);
        await setup.flush();

        expect(finishCalls).toBe(0);
        expect(closeCalls).toBe(0);
        expect(setup.captureCharFrame()).toContain(
            'Finish or cancel the active creator turn before completing authoring.'
        );
    });

    test('does not offer session navigation or recursive improvement while authoring', async () => {
        const result: AuthoringOperationResult = {
            id: 'author_tui_commands',
            kind: 'create',
            status: 'unchanged',
            packages: [],
            changedFiles: [],
        };
        const operation = {
            id: result.id,
            finish: async () => result,
            fail: async () => result,
        } as unknown as AuthoringOperation;
        const setup = await testRender(
            () => (
                <ThemeProvider controller={themes}>
                    <WorkbenchApp
                        home="/tmp/workbench-tui-tests"
                        entries={[]}
                        initial={{
                            alias: 'creator',
                            resolved: resolvedWorkbench(
                                'workbench-creator',
                                'opencode'
                            ),
                            operation,
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
        prompt.setText('/');
        await setup.flush();

        const frame = setup.captureCharFrame();
        expect(frame).toContain('/theme');
        expect(frame).not.toContain('/home');
        expect(frame).not.toContain('/resume');
        expect(frame).not.toContain('/rename');
        expect(frame).not.toContain('/improve');
    });

    test('fails authoring instead of verifying when the creator cannot start', async () => {
        let finishCalls = 0;
        let failedWith: string | undefined;
        let completed: AuthoringOperationResult | undefined;
        const result: AuthoringOperationResult = {
            id: 'author_tui_start_failure',
            kind: 'create',
            status: 'failed',
            packages: [],
            changedFiles: [],
            error: 'Creator could not start',
        };
        const operation = {
            id: result.id,
            finish: async () => {
                finishCalls += 1;
                return result;
            },
            fail: async (message: string) => {
                failedWith = message;
                return result;
            },
        } as unknown as AuthoringOperation;
        const setup = await testRender(
            () => (
                <ThemeProvider controller={themes}>
                    <WorkbenchApp
                        home="/tmp/workbench-tui-tests"
                        entries={[]}
                        initial={{
                            alias: 'creator',
                            resolved: resolvedWorkbench(
                                'workbench-creator',
                                'opencode'
                            ),
                            operation,
                        }}
                        resolve={async () => {
                            throw new Error('not opened in this test');
                        }}
                        start={async () => {
                            throw new Error('Creator could not start');
                        }}
                        onAuthoringFinished={(value) => {
                            completed = value;
                        }}
                    />
                </ThemeProvider>
            ),
            { width: 100, height: 32, exitOnCtrlC: false }
        );
        renderers.push(setup.renderer);
        await Bun.sleep(10);
        await setup.flush();
        expect(setup.captureCharFrame()).toContain('Creator could not start');

        setup.mockInput.pressCtrlC();
        await Bun.sleep(10);
        await setup.flush();

        expect(finishCalls).toBe(0);
        expect(failedWith).toBe('Creator could not start');
        expect(completed).toEqual(result);
    });

    test('keeps the creator open when engine verification fails', async () => {
        let closeCalls = 0;
        const operation = {
            id: 'author_tui_invalid',
            finish: async () => {
                throw new Error('Workbench core failed smoke: missing tool lux');
            },
            fail: async () => {
                throw new Error('should not fail');
            },
        } as unknown as AuthoringOperation;
        const handle = fakeHandle(() => {});
        handle.close = async () => {
            closeCalls += 1;
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
                            resolved: resolvedWorkbench(
                                'workbench-creator',
                                'opencode'
                            ),
                            operation,
                        }}
                        resolve={async () => {
                            throw new Error('not opened in this test');
                        }}
                        start={async () => handle}
                    />
                </ThemeProvider>
            ),
            { width: 100, height: 28, exitOnCtrlC: false }
        );
        renderers.push(setup.renderer);
        await Bun.sleep(10);
        await setup.flush();

        setup.mockInput.pressCtrlC();
        await Bun.sleep(10);
        await setup.flush();

        expect(closeCalls).toBe(0);
        expect(setup.renderer.isDestroyed).toBeFalse();
        expect(setup.captureCharFrame()).toContain(
            'Workbench core failed smoke: missing tool lux'
        );
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
        expect(
            lines.some(
                (line) => line.includes('/resume') && line.includes('Resume session')
            )
        ).toBeTrue();
    });

    test('completes a selected slash command before requiring its argument', async () => {
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

        const prompt = findPrompt(setup.renderer.root);
        prompt.setText('/ren');
        prompt.submit();
        await setup.flush();

        expect(prompt.plainText).toBe('/rename ');
        expect(setup.captureCharFrame()).not.toContain(
            'Rename requires a non-empty session name'
        );
    });

    test('executes a selected argument-free slash command immediately', async () => {
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

        const prompt = findPrompt(setup.renderer.root);
        prompt.setText('/th');
        prompt.submit();
        await setup.flush();

        expect(prompt.plainText).toBe('');
        expect(setup.captureCharFrame()).toContain('Themes');
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
            name: 'Native resume',
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
                            resolved: resolvedWorkbench(
                                'creator',
                                'opencode',
                                '/workspace/project'
                            ),
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
                        listSessions={(workspace) => {
                            expect(workspace).toBe('/workspace/project');
                            return store.list({
                                resumableOnly: true,
                                ...(workspace ? { workspace } : {}),
                            });
                        }}
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
        for (let attempt = 0; attempt < 100; attempt += 1) {
            await setup.flush();
            if (setup.captureCharFrame().includes('Ready when you are.')) break;
            await Bun.sleep(10);
        }
        expect(setup.captureCharFrame()).toContain('Ready when you are.');

        const prompt = findPrompt(setup.renderer.root);
        prompt.setText('/resume');
        prompt.submit();
        await Bun.sleep(20);
        await setup.flush();
        let frame = setup.captureCharFrame();
        expect(frame).toContain('Resume a previous session');
        expect(frame).toContain('Native resume');
        expect(frame).toContain('workbench-creator');
        expect(frame).toContain('opencode');

        findInput(setup.renderer.root, 'resume-search').submit();
        await Bun.sleep(20);
        await setup.flush();
        frame = setup.captureCharFrame();
        expect(resumed?.id).toBe(session.id);
        expect(frame).toContain('Native resume · workbench-creator');
    });

    test('names a new session from its first prompt', async () => {
        const home = await mkdtemp(join(tmpdir(), 'workbench-tui-default-name-'));
        temporaryDirectories.push(home);
        const store = new SessionStore(home);
        const session = await store.create({
            id: 'wb_tuidefaultname12345678901',
            workbench: 'workbench-creator',
            workbench_version: '0.1.3',
            runner: 'opencode',
            model: 'openai/gpt-5.6-terra',
            reference: 'creator',
            workbench_path: '/repo/.workbenches/creator',
            workspace: '/workspace/project',
            workspaces: [],
            native_session_id: 'ses_native_default_name',
            latest_run_id: 'wb_tuidefaultname12345678901',
        });
        const setup = await testRender(
            () => (
                <ThemeProvider controller={themes}>
                    <WorkbenchApp
                        home={home}
                        entries={[]}
                        initial={{
                            alias: 'creator',
                            resolved: resolvedWorkbench('creator', 'opencode'),
                            session,
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
        prompt.setText('Review the release configuration');
        prompt.submit();
        await waitForSessionName(store, session.id, 'Review the release configuration');
        await setup.flush();

        expect((await store.read(session.id)).name).toBe(
            'Review the release configuration'
        );
        expect(setup.captureCharFrame()).toContain(
            'Review the release configuration · creator'
        );
    });

    test('does not name a session from input rejected before delivery', async () => {
        const home = await mkdtemp(join(tmpdir(), 'workbench-tui-rejected-name-'));
        temporaryDirectories.push(home);
        const store = new SessionStore(home);
        const session = await store.create({
            id: 'wb_tuirejectedname1234567890',
            workbench: 'workbench-creator',
            workbench_version: '0.1.3',
            runner: 'opencode',
            model: 'openai/gpt-5.6-terra',
            reference: 'creator',
            workbench_path: '/repo/.workbenches/creator',
            workspace: '/workspace/project',
            workspaces: [],
            native_session_id: 'ses_native_rejected_name',
            latest_run_id: 'wb_tuirejectedname1234567890',
        });
        const handle = fakeHandle(() => {});
        handle.send = async () => {
            throw new Error('Input was rejected');
        };
        const setup = await testRender(
            () => (
                <ThemeProvider controller={themes}>
                    <WorkbenchApp
                        home={home}
                        entries={[]}
                        initial={{
                            alias: 'creator',
                            resolved: resolvedWorkbench('creator', 'opencode'),
                            session,
                        }}
                        resolve={async () => {
                            throw new Error('not opened in this test');
                        }}
                        start={async () => handle}
                    />
                </ThemeProvider>
            ),
            { width: 100, height: 32 }
        );
        renderers.push(setup.renderer);
        await Bun.sleep(10);
        await setup.flush();

        const prompt = findPrompt(setup.renderer.root);
        prompt.setText('This prompt was never accepted');
        prompt.submit();
        await Bun.sleep(20);
        await setup.flush();

        expect((await store.read(session.id)).name).toBeUndefined();
        expect(setup.captureCharFrame()).toContain('Input was rejected');
    });

    test('renames the current session and uses the name in session surfaces', async () => {
        const home = await mkdtemp(join(tmpdir(), 'workbench-tui-rename-'));
        temporaryDirectories.push(home);
        const store = new SessionStore(home);
        const session = await store.create({
            id: 'wb_tuirenamesession123456789',
            workbench: 'workbench-creator',
            workbench_version: '0.1.3',
            runner: 'opencode',
            model: 'openai/gpt-5.6-terra',
            reference: 'creator',
            workbench_path: '/repo/.workbenches/creator',
            workspace: '/workspace/project',
            workspaces: [],
            native_session_id: 'ses_native_rename',
            latest_run_id: 'wb_tuirenamesession123456789',
        });
        const setup = await testRender(
            () => (
                <ThemeProvider controller={themes}>
                    <WorkbenchApp
                        home={home}
                        entries={[]}
                        initial={{
                            alias: 'creator',
                            resolved: resolvedWorkbench('creator', 'opencode'),
                            session,
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

        let prompt = findPrompt(setup.renderer.root);
        prompt.setText('/rename Release review');
        prompt.submit();
        await waitForSessionName(store, session.id, 'Release review');
        await setup.flush();

        expect((await store.read(session.id)).name).toBe('Release review');
        expect(setup.captureCharFrame()).toContain('Release review · creator');

        prompt = findPrompt(setup.renderer.root);
        prompt.setText('/resume');
        prompt.submit();
        await Bun.sleep(10);
        await setup.flush();
        expect(setup.captureCharFrame()).toContain('Resume a previous session');
        expect(setup.captureCharFrame()).toContain('Release review');
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
        const frame = await waitForFrame(
            setup,
            (current) =>
                current.includes('Findings') &&
                current.includes('This is important.') &&
                current.includes('const safe = true'),
            'rendered assistant Markdown'
        );
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

    test('uses native incremental Markdown while assistant text is streaming', async () => {
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
        const frame = await waitForFrame(
            setup,
            (current) =>
                current.includes('Findings') &&
                current.includes('This is important.') &&
                current.includes('const safe = true'),
            'streaming assistant Markdown'
        );

        expect(frame).toContain('Findings');
        expect(frame).toContain('This is important.');
        expect(frame).toContain('✓ Checked');
        expect(frame).toContain('○ Follow up');
        expect(frame).toContain('const safe = true');
        expect(frame).not.toContain('# Findings');
        expect(frame).not.toContain('**important**');
        expect(frame).not.toContain('[x]');
        expect(frame).not.toContain('[ ]');
        expect(frame).not.toContain('```');
    });

    test('keeps the active assistant renderable mounted across streamed deltas', async () => {
        const nextChunk = deferred<void>();
        const handle = streamingHandle(nextChunk.promise);
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
            { width: 100, height: 28 }
        );
        renderers.push(setup.renderer);
        await Bun.sleep(10);
        await setup.flush();

        const first = setup.renderer.root.findDescendantById(
            'transcript-assistant-stream'
        );
        expect(first).toBeDefined();
        expect(setup.captureCharFrame()).toContain('First streamed line.');

        nextChunk.resolve();
        await Bun.sleep(10);
        await setup.flush();

        const updated = setup.renderer.root.findDescendantById(
            'transcript-assistant-stream'
        );
        expect(updated).toBe(first);
        expect(first?.isDestroyed).toBeFalse();
        expect(setup.captureCharFrame()).toContain('Second streamed line.');
    });

    test('renders a compact durable outcome card with explicit application state', async () => {
        const setup = await testRender(
            () => (
                <ThemeProvider controller={themes}>
                    <box width="100%" height="100%">
                        <Transcript
                            assistantLabel="fixture"
                            streaming={false}
                            item={{
                                id: 'outcome-card',
                                kind: 'outcome',
                                outcomeId: 'wbo_1234567890abcdefghij',
                                applicationState: 'pending',
                                completeness: 'complete',
                                changesets: 1,
                                artifacts: 2,
                                links: 1,
                                warnings: 0,
                                summary: 'Created a research report.',
                            }}
                        />
                    </box>
                </ThemeProvider>
            ),
            { width: 90, height: 12 }
        );
        renderers.push(setup.renderer);
        await setup.flush();
        const frame = setup.captureCharFrame();
        expect(frame).toContain('Outcome ready');
        expect(frame).toContain('pending');
        expect(frame).toContain('Created a research report.');
        expect(frame).toContain('1 changeset · 2 artifacts · 1 link');
        expect(frame).toContain('/outcome');
        expect(frame).toContain('wbo_1234567890abcdefghij');
    });

    test('does not call an empty durable outcome ready', async () => {
        const setup = await testRender(
            () => (
                <ThemeProvider controller={themes}>
                    <box width="100%" height="100%">
                        <Transcript
                            assistantLabel="fixture"
                            streaming={false}
                            item={{
                                id: 'empty-outcome-card',
                                kind: 'outcome',
                                outcomeId: 'wbo_1234567890abcdefghij',
                                applicationState: 'applied',
                                completeness: 'complete',
                                changesets: 0,
                                artifacts: 0,
                                links: 0,
                                warnings: 1,
                            }}
                        />
                    </box>
                </ThemeProvider>
            ),
            { width: 90, height: 12 }
        );
        renderers.push(setup.renderer);
        await setup.flush();
        const frame = setup.captureCharFrame();
        expect(frame).toContain('No saved results');
        expect(frame).toContain('1 warning');
        expect(frame).not.toContain('Outcome ready');
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

    test('renders multi-question progress without overlapping a long title', async () => {
        const longHeader =
            'The public site says Pompeii builds production agent infrastructure and open-sources what should exist for everyone';
        const setup = await testRender(
            () => (
                <ThemeProvider controller={themes}>
                    <QuestionPrompt
                        request={{
                            id: 'question-1',
                            questions: [
                                {
                                    header: longHeader,
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
                                {
                                    header: 'Confirmation',
                                    question: 'Continue?',
                                    options: [{ label: 'Yes' }],
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
        expect(frame).toContain('? The public site says Pompeii builds');
        expect(frame).not.toContain(longHeader);
        expect(frame).toContain('1/2');
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

function registryWorkbench(publisher: string, workbench: string): RegistrySearchResult {
    return {
        reference: { publisher, workbench },
        name: workbench,
        summary: 'Build production Cloudflare Workers with durable platform patterns.',
        runner: 'opencode',
        runtime: 'local',
        model: 'openai/gpt-5.6-terra',
        version: '1.2.0',
        sourceReference: `${publisher}/${workbench}#workers`,
        sourceUrl: `https://workbenches.dev/${publisher}/${workbench}`,
        publisherName: 'Cloudflare',
        verifiedPublisher: true,
        saves: 42,
        runs: 108,
    };
}

function registryEntry(workbench: RegistrySearchResult): CatalogEntry {
    return {
        alias: workbench.reference.workbench,
        name: workbench.name,
        version: workbench.version,
        source: workbench.sourceReference.split('#')[0] ?? workbench.sourceReference,
        selector: workbench.sourceReference.split('#')[1] ?? workbench.name,
        digest: `sha256:${'b'.repeat(64)}`,
        packagePath: `/tmp/${workbench.name}`,
        addedAt: '2026-09-08T00:00:00.000Z',
        registry: {
            url: 'https://api.workbenches.dev',
            publisher: workbench.reference.publisher,
            workbench: workbench.reference.workbench,
            version_id: 'version-id',
        },
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
        runtime: 'local',
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

async function waitForFrame(
    setup: Awaited<ReturnType<typeof testRender>>,
    matches: (frame: string) => boolean,
    description: string,
    timeoutMilliseconds = 2_000
): Promise<string> {
    const deadline = Date.now() + timeoutMilliseconds;
    let frame = setup.captureCharFrame();
    while (!matches(frame) && Date.now() < deadline) {
        await setup.flush();
        await setup.renderOnce();
        await Bun.sleep(5);
        frame = setup.captureCharFrame();
    }
    if (!matches(frame)) throw new Error(`Timed out waiting for ${description}`);
    return frame;
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

async function waitForSessionName(
    store: SessionStore,
    id: string,
    expected: string
): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((await store.read(id)).name === expected) return;
        await Bun.sleep(10);
    }
    expect((await store.read(id)).name).toBe(expected);
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

function streamingHandle(nextChunk: Promise<void>): RunHandle {
    const handle = fakeHandle(() => {});
    const observe: RunHandle['observe'] = (options = {}) =>
        (async function* () {
            yield event(0, 'run.ready', {});
            yield event(1, 'turn.started', { index: 1 });
            yield event(2, 'output.text', {
                id: 'assistant-stream',
                text: 'First streamed line.\n',
            });
            yield event(3, 'usage.updated', { total_tokens: 1 });
            await nextChunk;
            if (options.signal?.aborted) return;
            yield event(4, 'output.text', {
                id: 'assistant-stream',
                text: 'Second streamed line.',
            });
            yield event(5, 'usage.updated', { total_tokens: 2 });
        })();
    return { ...handle, observe };
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

function renderedLinks(root: Renderable): Array<{ text: string; uri: string }> {
    const links =
        root instanceof TextRenderable
            ? root.textNode
                  .toChunks()
                  .flatMap((chunk) =>
                      chunk.link ? [{ text: chunk.text, uri: chunk.link.url }] : []
                  )
            : [];
    for (const child of root.getChildren()) links.push(...renderedLinks(child));
    return links;
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
