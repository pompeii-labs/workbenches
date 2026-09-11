import type {
    AuthoringOperation,
    AuthoringOperationResult,
} from './authoring/index.js';
import { CliPresenter } from './commands/presenter.js';
import { SessionLifecycle, type StoredSession } from './sessions/index.js';
import { workbenchHome } from './storage.js';
import { TuiExitHandoff } from './tui/handoff.js';
import type { WorkbenchWorkspaceBinding } from './types.js';
import type { ResolvedWorkbenchReference } from './workbench/index.js';

export async function launchWorkbenchTui(
    options: {
        initial?: {
            alias: string;
            resolved: ResolvedWorkbenchReference;
            session?: StoredSession;
            prompt?: string;
            operation?: AuthoringOperation;
            environment?: Record<string, string | undefined>;
        };
        environment?: Record<string, string | undefined>;
        workspaces?: WorkbenchWorkspaceBinding[];
        allowHostDocker?: boolean;
    } = {}
): Promise<void> {
    assertWorkbenchTuiSupported();
    const tui = await import('./tui/index.js');
    const result = await tui.renderWorkbenchTui(options);
    presentAuthoringResults(result.authoringResults);
    await new TuiExitHandoff(
        new SessionLifecycle(workbenchHome()),
        new CliPresenter(),
        result.theme
    ).present(result.sessionId);
}

export function assertWorkbenchTuiSupported(): void {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
        throw new Error(
            'The Workbench TUI requires an interactive terminal. Use `wb list` or pass `--task` for a one-shot run.'
        );
    }
}

function presentAuthoringResults(results: AuthoringOperationResult[]): void {
    const output = new CliPresenter();
    for (const result of results) {
        const packageNames = result.packages.join(', ') || 'Workbench';
        output.record({
            machine: [
                result.status,
                packageNames,
                String(result.changedFiles.length),
                result.error,
            ],
            title:
                result.status === 'completed'
                    ? `${packageNames} authored successfully`
                    : result.status === 'unchanged'
                      ? `${packageNames} was unchanged`
                      : `${packageNames} authoring failed`,
            details:
                result.status === 'failed'
                    ? [result.error]
                    : [`${result.changedFiles.length} changed files`, 'smoke passed'],
            tone: result.status === 'failed' ? 'error' : 'success',
        });
        if (result.status === 'failed') process.exitCode = 1;
    }
}
