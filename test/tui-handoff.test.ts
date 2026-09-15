import { describe, expect, test } from 'bun:test';

import { CliPresenter } from '../src/commands/presenter.js';
import type {
    SessionActivity,
    SessionLifecycle,
    StoredSession,
} from '../src/sessions/index.js';
import { WorkbenchBrand } from '../src/tui/brand.js';
import { TuiExitHandoff } from '../src/tui/handoff.js';

const theme = {
    textMuted: '#96928B',
    accent: '#A78BFA',
    background: '#101011',
};

describe('TUI exit handoff', () => {
    test('prints a named resume handoff for a native resumable session', async () => {
        const written: string[] = [];
        const activity = resumableActivity('Release review');
        const handoff = new TuiExitHandoff(
            resolver(activity),
            new CliPresenter({
                interactive: true,
                color: false,
                stdout: (value) => written.push(value),
            }),
            theme
        );

        await handoff.present(activity.id);

        expect(written.join('')).toBe(
            `${new WorkbenchBrand().lines().join('\n')}\n● Session Release review\n  ID          ${activity.id}\n  Resume      wb resume ${activity.id}\n`
        );
    });

    test('preserves the TUI wordmark palette after leaving the alternate screen', async () => {
        const written: string[] = [];
        const activity = resumableActivity('Release review');
        const handoff = new TuiExitHandoff(
            resolver(activity),
            new CliPresenter({
                interactive: true,
                color: true,
                stdout: (value) => written.push(value),
            }),
            theme
        );

        await handoff.present(activity.id);

        const output = written.join('');
        const logo = output.split('\n').slice(0, 4).join('\n');
        expect(logo).toContain('\u001b[38;2;150;146;139m');
        expect(logo).toContain('\u001b[1;38;2;167;139;250m');
        expect(logo).not.toContain('\u001b[36m');
    });

    test('does not claim resume for absent or non-resumable sessions', async () => {
        const written: string[] = [];
        const activity = { ...resumableActivity(), resumable: false };
        const output = new CliPresenter({
            interactive: true,
            color: false,
            stdout: (value) => written.push(value),
        });

        await new TuiExitHandoff(resolver(activity), output, theme).present(
            activity.id
        );
        await new TuiExitHandoff(
            {
                resolve: async () => {
                    throw new Error('missing');
                },
            },
            output,
            theme
        ).present('wb_missinghandoff1234567890');
        await new TuiExitHandoff(resolver(activity), output, theme).present(undefined);

        expect(written).toEqual([]);
    });
});

function resolver(activity: SessionActivity): Pick<SessionLifecycle, 'resolve'> {
    return { resolve: async () => activity };
}

function resumableActivity(name?: string): SessionActivity {
    const id = 'wb_handoffsession12345678901';
    const session: StoredSession = {
        version: 1,
        id,
        ...(name ? { name } : {}),
        workbench: 'lux-ops',
        workbench_version: '0.1.0',
        runner: 'opencode',
        model: 'openai/gpt-5.6-terra',
        runtime: 'local',
        reference: 'lux-ops',
        workbench_path: '/repo/.workbenches/lux-ops',
        workspace: '/repo',
        workspaces: [],
        native_session_id: 'ses_native_handoff',
        latest_run_id: id,
        created_at: '2026-09-08T00:00:00.000Z',
        updated_at: '2026-09-08T00:00:00.000Z',
    };
    return {
        id,
        session,
        resumable: true,
        run: {
            version: 1,
            id,
            status: 'completed',
            workbench: session.workbench,
            workbench_version: session.workbench_version,
            runner: session.runner,
            model: session.model,
            runtime: session.runtime,
            workspace: session.workspace,
            mode: 'interactive',
            session_id: id,
            dispatched_at: '2026-09-08T00:00:00.000Z',
            updated_at: '2026-09-08T00:00:00.000Z',
        },
    } as SessionActivity;
}
