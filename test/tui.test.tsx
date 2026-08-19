import { afterEach, describe, expect, test } from 'bun:test';
import { testRender } from '@opentui/solid';

import type { CatalogEntry } from '../src/catalog.js';
import { Transcript, WorkbenchApp } from '../src/tui/app.js';

const renderers: Array<{ destroy(): void }> = [];

afterEach(() => {
    for (const renderer of renderers.splice(0)) renderer.destroy();
});

describe.serial('Workbench TUI', () => {
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
        await setup.flush();
        await Bun.sleep(250);
        await setup.flush();

        const frame = setup.captureCharFrame();
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
