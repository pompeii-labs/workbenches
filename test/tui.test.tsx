import { afterEach, describe, expect, test } from 'bun:test';
import { testRender } from '@opentui/solid';

import type { CatalogEntry } from '../src/catalog/index.js';
import type {
    RunControlDisposition,
    RunControlKind,
    RunControlReceipt,
    RunHandle,
} from '../src/runs/index.js';
import { Transcript, WorkbenchApp } from '../src/tui/app.js';
import { TurnCancellation } from '../src/tui/chat.js';
import { holdRendererUntilShutdown } from '../src/tui/lifecycle.js';
import type { ResolvedWorkbenchReference } from '../src/workbench/index.js';

const renderers: Array<{ destroy(): void }> = [];

afterEach(() => {
    for (const renderer of renderers.splice(0)) renderer.destroy();
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
                <WorkbenchApp
                    entries={[entry('lux-core'), entry('lux-migrations')]}
                    resolve={async () => {
                        throw new Error('not opened in this test');
                    }}
                    start={async () => {
                        throw new Error('not started in this test');
                    }}
                />
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
                <WorkbenchApp
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
            ),
            { width: 100, height: 28 }
        );
        renderers.push(setup.renderer);
        await setup.flush();

        const frame = setup.captureCharFrame();
        expect(frame).toContain('pi · openai/gpt-5.4-mini · local');
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

function resolvedWorkbench(name: string, runner: string): ResolvedWorkbenchReference {
    return {
        workspaceDirectory: '/tmp/workspace',
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
