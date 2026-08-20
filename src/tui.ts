import type { ResolvedReference } from './references.js';

export async function launchWorkbenchTui(
    options: {
        initial?: { alias: string; resolved: ResolvedReference };
        environment?: Record<string, string | undefined>;
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
