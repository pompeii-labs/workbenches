import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { testRender } from '@opentui/solid';
import type { CatalogEntry } from '../../src/catalog/index.js';
import { OutcomeStore } from '../../src/outcomes/store.js';
import {
    RepositoryGitHub,
    RepositoryInspection,
} from '../../src/repositories/index.js';
import { RepositoryDeliveryStore } from '../../src/repositories/receipts.js';
import type { RunHandle, WorkbenchEvent } from '../../src/runs/index.js';
import { RunStore } from '../../src/runs/store.js';
import { ChatScreen } from '../../src/tui/chat.js';
import { DialogProvider } from '../../src/tui/dialog/index.js';
import { OutcomeDialog } from '../../src/tui/dialog/outcome.js';
import { HomeScreen } from '../../src/tui/home.js';
import { RepositoryController } from '../../src/tui/repository/controller.js';
import { RepositoryPanel } from '../../src/tui/repository/panel.js';
import { ThemeController, ThemeProvider } from '../../src/tui/theme/index.js';
import type { ResolvedWorkbenchReference } from '../../src/workbench/index.js';
import { binding, GitHubFixture, result, temporary } from './fixture.js';

const renderers: Array<{ destroy(): void }> = [];
const controllers: RepositoryController[] = [];
afterEach(() => {
    for (const controller of controllers.splice(0)) controller.dispose();
    for (const renderer of renderers.splice(0)) renderer.destroy();
});

function entry(): CatalogEntry {
    return {
        alias: 'engineer',
        name: 'engineer',
        version: '0.1.0',
        source: 'example/project',
        selector: 'engineer',
        digest: `sha256:${'a'.repeat(64)}`,
        packagePath: '/package',
        addedAt: new Date().toISOString(),
    };
}
function resolved(): ResolvedWorkbenchReference {
    return {
        workspaceDirectory: '/caller',
        cleanup: async () => {},
        workbench: {
            manifestPath: '/package/workbench.yml',
            packageDirectory: '/package',
            repositoryDirectory: '/package',
            instructionsPath: '/package/instructions.md',
            skills: [],
            manifest: {
                spec: 0,
                version: '0.1.0',
                name: 'engineer',
                runner: 'opencode',
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
async function render(
    home: string,
    element: () => ReturnType<typeof HomeScreen>,
    width = 100,
    height = 32
) {
    const setup = await testRender(
        () => (
            <ThemeProvider controller={new ThemeController(home)}>
                <DialogProvider>{element()}</DialogProvider>
            </ThemeProvider>
        ),
        { width, height }
    );
    renderers.push(setup.renderer);
    await setup.flush();
    return setup;
}
async function settle(setup: { flush(): Promise<void> }) {
    await Bun.sleep(40);
    await setup.flush();
}

async function fixture() {
    const home = await temporary();
    const outcome = await result(home);
    const receipts = new RepositoryDeliveryStore(home);
    const head = 'f'.repeat(40);
    const branch = `workbenches/${binding.session_id}`;
    const url = 'https://github.com/example/project/pull/1';
    const receipt = {
        version: 1 as const,
        run_id: outcome.run_id,
        session_id: binding.session_id,
        outcome_id: outcome.id,
        repository: 'example/project',
        revision: binding.revision,
        base_branch: 'main',
        branch,
        created_at: new Date().toISOString(),
        state: 'published' as const,
        commit: head,
        tree: 'e'.repeat(40),
        pull_request: { number: 1, url },
    };
    await receipts.write(receipt);
    const workflow = {
        id: 2,
        workflow_id: 1,
        head_sha: head,
        head_branch: branch,
        status: 'completed',
        conclusion: 'failure',
        html_url: 'https://github.com/example/project/actions/runs/2',
        name: 'Build',
    };
    const job = {
        id: 9,
        run_id: 2,
        head_sha: head,
        status: 'completed',
        conclusion: 'failure',
        name: 'Typecheck',
        html_url: 'https://github.com/example/project/actions/runs/2/job/9',
    };
    const responses: Record<string, unknown> = {
        '/pulls/1': {
            number: 1,
            html_url: url,
            state: 'open',
            merged: false,
            draft: true,
            head: { sha: head, ref: branch, repo: { full_name: 'example/project' } },
            base: { ref: 'main' },
        },
        [`/commits/${head}/check-runs`]: {
            total_count: 1,
            check_runs: [
                {
                    id: 1,
                    head_sha: head,
                    name: 'Compile',
                    status: 'completed',
                    conclusion: 'failure',
                    details_url: url,
                },
            ],
        },
        [`/commits/${head}/status`]: { total_count: 0, statuses: [] },
        '/actions/runs': { total_count: 1, workflow_runs: [workflow] },
        '/actions/runs/2/jobs': { total_count: 1, jobs: [job] },
        '/actions/jobs/9': job,
        '/actions/runs/2': workflow,
    };
    const requests: string[] = [];
    const opened: string[] = [];
    const github = new RepositoryGitHub('fixture-credential', (async (input, init) => {
        expect(init?.method ?? 'GET').toBe('GET');
        const path = new URL(String(input)).pathname.replace(
            '/repos/example/project',
            ''
        );
        requests.push(path);
        if (path === '/actions/jobs/9/logs')
            return new Response(
                'error TS123: fix the type\n\u001b[31muntrusted ANSI\n'
            );
        if (!(path in responses))
            throw new Error(`Unexpected inspection request ${path}`);
        return Response.json(responses[path]);
    }) as typeof fetch);
    const inspection = new RepositoryInspection(home, outcome.run_id, {}, github);
    const controller = new RepositoryController(
        { repository: 'example/project' },
        binding,
        () => inspection,
        async (url) => {
            opened.push(url);
        }
    );
    controllers.push(controller);
    await controller.attach(outcome.run_id);
    return {
        home,
        outcome,
        receipts,
        receipt,
        responses,
        requests,
        opened,
        inspection,
        controller,
    };
}

describe.serial('repository keyboard interface', () => {
    test('every Workbench offers a launch target and current directory is the default choice', async () => {
        const home = await temporary();
        const launches: ResolvedWorkbenchReference[] = [];
        const setup = await render(home, () => (
            <HomeScreen
                entries={[entry()]}
                resolve={async () => resolved()}
                onOpen={(_, value) => launches.push(value)}
                onBrowseSessions={() => {}}
                onExit={() => {}}
            />
        ));
        await setup.mockInput.typeText('engineer');
        setup.mockInput.pressEnter();
        await settle(setup);
        expect(launches).toEqual([]);
        const frame = setup.captureCharFrame();
        expect(frame).toContain('Current directory');
        expect(frame).toContain('Another directory');
        expect(frame).toContain('GitHub repository');
        setup.mockInput.pressEnter();
        await settle(setup);
        expect(launches).toHaveLength(1);
        expect(launches[0]?.workspaceDirectory).toBe('/caller');
        expect(launches[0]?.repository).toBeUndefined();
    });
    test('another directory completes a path and becomes the chat workspace', async () => {
        const home = await temporary();
        const project = join(home, 'project');
        await mkdir(project);
        const launches: ResolvedWorkbenchReference[] = [];
        const setup = await render(home, () => (
            <HomeScreen
                entries={[entry()]}
                resolve={async () => ({ ...resolved(), workspaceDirectory: home })}
                onOpen={(_, value) => launches.push(value)}
                onBrowseSessions={() => {}}
                onExit={() => {}}
            />
        ));
        await setup.mockInput.typeText('engineer');
        setup.mockInput.pressEnter();
        await settle(setup);
        setup.mockInput.pressArrow('down');
        setup.mockInput.pressEnter();
        await settle(setup);
        expect(setup.renderer.currentFocusedRenderable?.id).toBe('launch-directory');
        await setup.mockInput.typeText('./pro');
        await settle(setup);
        expect(setup.captureCharFrame()).toContain('./project/');
        setup.mockInput.pressTab();
        await settle(setup);
        expect(setup.captureCharFrame()).toContain('./project/');
        setup.mockInput.pressEnter();
        await settle(setup);
        expect(launches).toHaveLength(1);
        expect(launches[0]?.workspaceDirectory).toBe(project);
        expect(launches[0]?.repository).toBeUndefined();
    });
    test('an invalid directory remains in the picker instead of starting a run', async () => {
        const home = await temporary();
        const launches: ResolvedWorkbenchReference[] = [];
        const setup = await render(home, () => (
            <HomeScreen
                entries={[entry()]}
                resolve={async () => ({ ...resolved(), workspaceDirectory: home })}
                onOpen={(_, value) => launches.push(value)}
                onBrowseSessions={() => {}}
                onExit={() => {}}
            />
        ));
        await setup.mockInput.typeText('engineer');
        setup.mockInput.pressEnter();
        await settle(setup);
        setup.mockInput.pressArrow('down');
        setup.mockInput.pressEnter();
        await settle(setup);
        await setup.mockInput.typeText('./missing');
        setup.mockInput.pressEnter();
        await settle(setup);
        expect(launches).toEqual([]);
        expect(setup.captureCharFrame()).toContain('Directory does not exist');
    });
    test('an unsaved registry result is saved and configured before starting a GitHub run', async () => {
        const home = await temporary();
        const launches: ResolvedWorkbenchReference[] = [];
        let saves = 0;
        const setup = await render(home, () => (
            <HomeScreen
                entries={[]}
                resolve={async () => resolved()}
                searchRegistry={async () => [
                    {
                        reference: { publisher: 'example', workbench: 'engineer' },
                        name: 'engineer',
                        version: '0.1.0',
                        runner: 'opencode',
                        runtime: 'local',
                        model: 'openai/gpt-5.4-mini',
                        sourceReference: 'example/engineer#core',
                        sourceUrl: 'https://workbenches.dev/example/engineer',
                        publisherName: 'example',
                        verifiedPublisher: false,
                        saves: 0,
                        runs: 0,
                    },
                ]}
                onSaveRegistry={async () => {
                    saves++;
                    return entry();
                }}
                onOpen={(_, value) => launches.push(value)}
                onBrowseSessions={() => {}}
                onExit={() => {}}
            />
        ));
        await setup.mockInput.typeText('engineer');
        await Bun.sleep(230);
        await setup.flush();
        setup.mockInput.pressEnter();
        await settle(setup);
        expect(saves).toBe(1);
        expect(launches).toEqual([]);
        expect(setup.captureCharFrame()).toContain('Launch Workbench');
        setup.mockInput.pressArrow('down');
        setup.mockInput.pressArrow('down');
        setup.mockInput.pressEnter();
        await settle(setup);
        expect(setup.captureCharFrame()).toContain('Run on GitHub');
        await setup.mockInput.typeText('example/project');
        setup.mockInput.pressEnter();
        await settle(setup);
        expect(launches).toHaveLength(1);
        expect(launches[0]?.repository).toEqual({ repository: 'example/project' });
    });
    test('a delayed old-head CI response cannot replace a new publication', async () => {
        const f = await fixture();
        const old = await f.inspection.checks();
        let entered!: () => void;
        const waiting = new Promise<void>((resolve) => {
            entered = resolve;
        });
        let release!: () => void;
        const pending = new Promise<void>((resolve) => {
            release = resolve;
        });
        const inspection = new (class extends RepositoryInspection {
            override async checks() {
                entered();
                await pending;
                return old;
            }
        })(f.home, f.outcome.run_id, {});
        const controller = new RepositoryController(
            { repository: 'example/project' },
            binding,
            () => inspection
        );
        controllers.push(controller);
        await controller.attach(f.outcome.run_id);
        const refresh = controller.refresh();
        await waiting;
        await f.receipts.write({ ...f.receipt, commit: '8'.repeat(40) });
        await controller.load();
        release();
        await refresh;
        expect(controller.state().checks).toBeUndefined();
        expect(controller.state().checkedAt).toBeUndefined();
    });
    test('home configures repository and base before starting an authenticated GitHub run', async () => {
        const home = await temporary();
        const launches: ResolvedWorkbenchReference[] = [];
        const setup = await render(home, () => (
            <HomeScreen
                entries={[entry()]}
                resolve={async () => resolved()}
                onOpen={(_, value) => launches.push(value)}
                onBrowseSessions={() => {}}
                onExit={() => {}}
            />
        ));
        await setup.mockInput.typeText('engineer');
        setup.mockInput.pressEnter();
        await settle(setup);
        expect(setup.captureCharFrame()).toContain('Launch Workbench');
        setup.mockInput.pressArrow('down');
        setup.mockInput.pressArrow('down');
        setup.mockInput.pressEnter();
        await settle(setup);
        expect(setup.captureCharFrame()).toContain('Run on GitHub');
        expect(launches).toEqual([]);
        await setup.mockInput.typeText('example/project');
        setup.mockInput.pressTab();
        await setup.mockInput.typeText('develop');
        await setup.flush();
        expect(setup.captureCharFrame()).toContain('Uses your GitHub credential');
        setup.mockInput.pressEnter();
        await settle(setup);
        expect(launches).toHaveLength(1);
        expect(launches[0]?.repository).toEqual({
            repository: 'example/project',
            ref: 'develop',
        });
    });
    test('home rejects invalid targets and restores focus on cancel', async () => {
        const home = await temporary();
        const launches: ResolvedWorkbenchReference[] = [];
        let exits = 0;
        const setup = await render(
            home,
            () => (
                <HomeScreen
                    entries={[entry()]}
                    resolve={async () => resolved()}
                    onOpen={(_, value) => launches.push(value)}
                    onBrowseSessions={() => {}}
                    onExit={() => {
                        exits++;
                    }}
                />
            ),
            72,
            28
        );
        await setup.mockInput.typeText('engineer');
        setup.mockInput.pressEnter();
        await settle(setup);
        setup.mockInput.pressArrow('down');
        setup.mockInput.pressArrow('down');
        setup.mockInput.pressEnter();
        await settle(setup);
        await setup.mockInput.typeText('invalid');
        setup.mockInput.pressEnter();
        await setup.flush();
        expect(launches).toEqual([]);
        expect(setup.captureCharFrame()).toContain('GitHub');
        setup.mockInput.pressEscape();
        await settle(setup);
        expect(exits).toBe(0);
        expect(setup.renderer.currentFocusedRenderable?.id).toBe('home-launcher');
        setup.mockInput.pressEnter();
        await settle(setup);
        setup.mockInput.pressArrow('down');
        setup.mockInput.pressArrow('down');
        setup.mockInput.pressEnter();
        await settle(setup);
        await setup.mockInput.typeText('example/project');
        setup.mockInput.pressEnter();
        await settle(setup);
        expect(launches).toHaveLength(1);
        expect(launches[0]?.repository).toEqual({ repository: 'example/project' });
    });
    test('panel reads actual named CI and job logs, opens links by keyboard and stops watching on unmount', async () => {
        const f = await fixture();
        const setup = await render(f.home, () => (
            <RepositoryPanel controller={f.controller} home={f.home} />
        ));
        await settle(setup);
        const frame = setup.captureCharFrame();
        expect(frame).toContain('PR #1');
        expect(frame).toContain('CI failed');
        expect(frame).toContain('Compile');
        expect(frame).toContain('Typecheck');
        expect(frame).not.toContain('fixture-credential');
        setup.mockInput.pressKey('o');
        setup.mockInput.pressKey('v');
        await settle(setup);
        expect(f.opened).toEqual([
            f.receipt.pull_request.url,
            'https://github.com/example/project/actions/runs/2/job/9',
        ]);
        setup.mockInput.pressEnter();
        await settle(setup);
        expect(setup.captureCharFrame()).toContain('error TS123');
        expect(setup.captureCharFrame()).not.toContain('\u001b');
        setup.mockInput.pressKey('b');
        setup.mockInput.pressKey('w');
        await settle(setup);
        expect(f.controller.state().watching).toBe(true);
        const before = f.requests.length;
        setup.mockInput.pressKey('r');
        await settle(setup);
        expect(f.requests.length).toBeGreaterThan(before);
        setup.renderer.destroy();
        expect(f.controller.state().watching).toBe(false);
    });
    test('a new published head clears old CI rather than showing stale failure or success', async () => {
        const f = await fixture();
        await f.controller.refresh();
        expect(f.controller.state().checks?.state).toBe('failed');
        await f.receipts.write({ ...f.receipt, commit: '8'.repeat(40) });
        await f.controller.load();
        expect(f.controller.state().checks).toBeUndefined();
        expect(f.controller.state().checkedAt).toBeUndefined();
        await f.controller.refresh();
        expect(f.controller.state().error).toContain('changed outside');
        expect(f.controller.state().checks).toBeUndefined();
    });
    test('job selection stays usable when a refresh removes the selected job', async () => {
        const f = await fixture();
        const job = f.responses['/actions/jobs/9'] as Record<string, unknown>;
        f.responses['/actions/runs/2/jobs'] = {
            total_count: 2,
            jobs: [job, { ...job, id: 10, name: 'Removed job' }],
        };
        const setup = await render(f.home, () => (
            <RepositoryPanel controller={f.controller} home={f.home} />
        ));
        await settle(setup);
        setup.mockInput.pressArrow('down');
        await setup.flush();
        f.responses['/actions/runs/2/jobs'] = { total_count: 1, jobs: [job] };
        setup.mockInput.pressKey('r');
        await settle(setup);
        setup.mockInput.pressEnter();
        await settle(setup);
        expect(setup.captureCharFrame()).toContain('error TS123');
        expect(f.requests).toContain('/actions/jobs/9/logs');
    });
    test('the GitHub panel cannot publish saved work through a keyboard shortcut', async () => {
        const home = await temporary();
        const store = new OutcomeStore(home);
        const content = await store.putBytes('checkpoint', 'text/plain');
        const outcome = await result(home, [
            {
                path: 'feature.txt',
                operation: 'add',
                after: { kind: 'file', mode: 0o644, content },
            },
        ]);
        const github = new GitHubFixture();
        await new RepositoryDeliveryStore(home).write({
            version: 1,
            run_id: outcome.run_id,
            session_id: binding.session_id,
            outcome_id: outcome.id,
            repository: 'example/project',
            revision: binding.revision,
            base_branch: binding.base_branch,
            branch: `workbenches/${binding.session_id}`,
            created_at: new Date().toISOString(),
            state: 'failed',
            message: 'Historical publication failed',
        });
        const snapshot = {
            ...outcome,
            id: OutcomeStore.createId(),
            turn_index: 2,
            completeness: 'partial' as const,
            changesets: [],
        };
        await store.commit(snapshot, 'present');
        await store.close();
        await new RunStore(home).update(outcome.run_id, { outcome_id: snapshot.id });
        const controller = new RepositoryController(
            { repository: 'example/project' },
            binding,
            () => new RepositoryInspection(home, outcome.run_id, {}, github.client)
        );
        controllers.push(controller);
        await controller.attach(outcome.run_id);
        const setup = await render(home, () => (
            <RepositoryPanel controller={controller} home={home} />
        ));
        await settle(setup);
        expect(setup.captureCharFrame()).not.toContain('retry');
        const calls = github.calls.length;
        github.fail = '';
        setup.mockInput.pressKey('p');
        await settle(setup);
        expect(controller.state().status?.receipt).toMatchObject({
            state: 'failed',
            outcome_id: outcome.id,
        });
        expect(github.calls).toHaveLength(calls);
    });
    test('in-chat GitHub commands and runtime inspection do not send any model input and restore composer focus', async () => {
        const f = await fixture();
        const sends: unknown[] = [];
        const event: WorkbenchEvent = {
            protocol: 0,
            run_id: f.outcome.run_id,
            sequence: 1,
            timestamp: new Date().toISOString(),
            type: 'run.ready',
            runner: 'opencode',
            data: {},
        };
        const handle = {
            runId: f.outcome.run_id,
            observe: () =>
                (async function* () {
                    yield event;
                })(),
            detach: async () => {},
            send: async (input: unknown) => {
                sends.push(input);
            },
        } as unknown as RunHandle;
        const setup = await render(
            f.home,
            () => (
                <ChatScreen
                    home={f.home}
                    alias="engineer"
                    resolved={{
                        ...resolved(),
                        repository: { repository: 'example/project' },
                    }}
                    start={async () => handle}
                    repositoryInspection={() => f.inspection}
                    onBack={() => {}}
                    onBrowseSessions={() => {}}
                    onExit={() => {}}
                    homeAvailable={true}
                />
            ),
            100,
            36
        );
        await settle(setup);
        expect(setup.captureCharFrame()).toContain('example/project');
        expect(setup.captureCharFrame()).toContain('GitHub auth enabled');
        await setup.mockInput.typeText('/runtime');
        setup.mockInput.pressEnter();
        await settle(setup);
        expect(setup.captureCharFrame()).toContain('/sessions/');
        expect(setup.captureCharFrame()).not.toContain('/caller');
        setup.mockInput.pressEscape();
        await settle(setup);
        setup.mockInput.pressKey('g', { ctrl: true });
        await settle(setup);
        expect(setup.captureCharFrame()).toContain('Typecheck');
        setup.mockInput.pressEscape();
        await settle(setup);
        await setup.mockInput.typeText('/checks');
        setup.mockInput.pressEnter();
        await settle(setup);
        expect(setup.captureCharFrame()).toContain('CI failed');
        expect(sends).toEqual([]);
    });
    test('outcome diff toggles by keyboard without offering removed publication retry', async () => {
        const f = await fixture();
        const publication = OutcomeStore.createId();
        const setup = await render(
            f.home,
            () => (
                <OutcomeDialog
                    data={{
                        outcome: f.outcome,
                        state: 'present',
                        artifacts: [],
                        delivery: {
                            ...f.receipt,
                            state: 'failed',
                            outcome_id: publication,
                            message: 'HTTP 502',
                        },
                        reviews: [
                            {
                                name: 'Workspace changes',
                                text: 'diff --git a/feature b/feature\n+new content',
                                truncated: false,
                            },
                        ],
                    }}
                />
            ),
            100,
            40
        );
        expect(setup.captureCharFrame()).toContain('Resume the agent');
        expect(setup.captureCharFrame()).not.toContain('--deliver');
        setup.mockInput.pressKey('d');
        await setup.flush();
        expect(setup.captureCharFrame()).toContain('+new content');
        setup.mockInput.pressKey('d');
        await setup.flush();
        expect(setup.captureCharFrame()).toContain('Resume the agent');
    });
});
