import type { StoredSession } from './sessions/index.js';
import type { WorkbenchWorkspaceBinding } from './types.js';
import type { ResolvedWorkbenchReference } from './workbench/index.js';

export async function launchWorkbenchTui(
    options: {
        initial?: {
            alias: string;
            resolved: ResolvedWorkbenchReference;
            session?: StoredSession;
        };
        environment?: Record<string, string | undefined>;
        workspaces?: WorkbenchWorkspaceBinding[];
    } = {}
): Promise<void> {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
        throw new Error(
            'The Workbench TUI requires an interactive terminal. Use `wb list` or pass `--task` for a one-shot run.'
        );
    }
    const tui = await import('./tui/index.js');
    await tui.renderWorkbenchTui(options);
}
