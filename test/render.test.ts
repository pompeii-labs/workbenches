import { describe, expect, test } from 'bun:test';

import type { WorkbenchEvent, WorkbenchEventType } from '../src/execution.js';
import { createEventRenderer } from '../src/render.js';

describe('Workbench event renderers', () => {
    test('emits one complete normalized JSON event per line', () => {
        let output = '';
        const renderer = createEventRenderer({
            mode: 'json',
            stdout: (value) => {
                output += value;
            },
        });
        renderer.render(event(1, 'run.started', { workbench: 'lux-core' }));
        renderer.render(event(2, 'run.completed', { exit_code: 0 }));
        renderer.finish();

        const lines = output.trim().split('\n');
        expect(lines).toHaveLength(2);
        expect(lines.map((line) => JSON.parse(line))).toMatchObject([
            { protocol: 0, sequence: 1, type: 'run.started' },
            { protocol: 0, sequence: 2, type: 'run.completed' },
        ]);
    });

    test('prints only assistant text in final mode', () => {
        let stdout = '';
        let stderr = '';
        const renderer = createEventRenderer({
            mode: 'final',
            stdout: (value) => {
                stdout += value;
            },
            stderr: (value) => {
                stderr += value;
            },
        });
        renderer.render(event(1, 'tool.started', { name: 'read' }));
        renderer.render(event(2, 'output.text', { text: 'Hello ' }));
        renderer.render(event(3, 'output.text', { text: 'world' }));
        renderer.render(event(4, 'run.completed', {}));
        renderer.finish();

        expect(stdout).toBe('Hello world\n');
        expect(stderr).toBe('');
    });

    test('renders a compact human activity stream and aggregates usage deltas', () => {
        let stdout = '';
        let stderr = '';
        const renderer = createEventRenderer({
            mode: 'human',
            color: false,
            stdout: (value) => {
                stdout += value;
            },
            stderr: (value) => {
                stderr += value;
            },
        });
        for (const next of [
            event(1, 'run.started', {
                workbench: 'lux-core',
                model: 'openrouter/openai/gpt-5.6-luna',
                runtime: 'local',
                workspace: '/repo',
            }),
            event(2, 'run.ready', { tools: ['cargo', 'lux'], disabled_mcps: [] }),
            event(3, 'tool.started', {
                id: '1',
                name: 'read',
                target: '/repo/Cargo.toml',
            }),
            event(4, 'tool.completed', {
                id: '1',
                name: 'read',
                target: '/repo/Cargo.toml',
                status: 'completed',
                duration_ms: 12,
            }),
            event(5, 'output.text', { text: 'Lux is ready.' }),
            event(6, 'usage.updated', {
                kind: 'delta',
                total_tokens: 10,
                cost_usd: 0.001,
            }),
            event(7, 'usage.updated', {
                kind: 'delta',
                total_tokens: 5,
                cost_usd: 0.0005,
            }),
            event(8, 'run.completed', { duration_ms: 7654 }),
        ]) {
            renderer.render(next);
        }
        renderer.finish();

        expect(stdout).toContain('● lux-core');
        expect(stdout).toContain('OpenCode · openrouter/openai/gpt-5.6-luna · local');
        expect(stdout).toContain('✓ Ready · cargo, lux');
        expect(stdout).toContain('→ Read · Cargo.toml');
        expect(stdout).not.toContain('/repo/Cargo.toml');
        expect(stdout).toContain('Lux is ready.');
        expect(stdout).toContain('✓ Completed · 7.7s · 15 tokens · $0.0015');
        expect(stderr).toBe('');
    });

    test('renders optional integrations, file changes, input, and failures safely', () => {
        let stdout = '';
        let stderr = '';
        const renderer = createEventRenderer({
            mode: 'human',
            color: false,
            stdout: (value) => {
                stdout += value;
            },
            stderr: (value) => {
                stderr += value;
            },
        });
        for (const next of [
            event(1, 'run.started', {}),
            event(2, 'run.ready', { disabled_mcps: ['lux'] }),
            event(3, 'tool.completed', { name: 'shell_command', status: 'failed' }),
            event(4, 'file.changed', { path: 'schema.sql', operation: 'edit' }),
            event(5, 'input.requested', { message: 'Approve migration?' }),
            event(6, 'run.failed', { message: 'permission denied' }),
            event(7, 'run.cancelled', {}),
        ]) {
            renderer.render(next);
        }
        renderer.finish();

        expect(stdout).toContain('● Workbench');
        expect(stdout).toContain('○ MCP unavailable · lux (optional)');
        expect(stdout).toContain('✗ Shell command');
        expect(stdout).toContain('~ edit schema.sql');
        expect(stdout).toContain('? Input required · Approve migration?');
        expect(stderr).toContain('✗ Failed · permission denied');
        expect(stderr).toContain('■ Cancelled');
    });

    test('colorizes only the human renderer when explicitly enabled', () => {
        let human = '';
        const colored = createEventRenderer({
            mode: 'human',
            color: true,
            stdout: (value) => {
                human += value;
            },
        });
        colored.render(
            event(1, 'run.started', {
                workbench: 'lux-core',
                model: 'model',
                runtime: 'local',
            })
        );
        colored.render(event(2, 'run.completed', { duration_ms: 1000 }));
        colored.finish();
        expect(human).toContain('\u001B[');

        let json = '';
        const machine = createEventRenderer({
            mode: 'json',
            color: true,
            stdout: (value) => {
                json += value;
            },
        });
        machine.render(event(1, 'run.completed', {}));
        machine.finish();
        expect(json).not.toContain('\u001B[');
        expect(JSON.parse(json)).toMatchObject({ type: 'run.completed' });
    });

    test('reports a failure in final-only mode without inventing an answer', () => {
        let stdout = '';
        let stderr = '';
        const renderer = createEventRenderer({
            mode: 'final',
            stdout: (value) => {
                stdout += value;
            },
            stderr: (value) => {
                stderr += value;
            },
        });
        renderer.render(event(1, 'run.failed', { message: 'runner unavailable' }));
        renderer.finish();

        expect(stdout).toBe('');
        expect(stderr).toBe('error: runner unavailable\n');
    });
});

function event(
    sequence: number,
    type: WorkbenchEventType,
    data: Record<string, unknown>
): WorkbenchEvent {
    return {
        protocol: 0,
        run_id: 'wb_test00000000000000000000',
        sequence,
        timestamp: '2026-08-18T00:00:00.000Z',
        type,
        runner: 'opencode',
        data,
    };
}
