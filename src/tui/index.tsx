import { createCliRenderer } from '@opentui/core';
import { render } from '@opentui/solid';

import { SavedWorkbenchCatalog } from '../catalog/index.js';
import { RunDispatcher, RunStore } from '../runs/index.js';
import { workbenchHome } from '../storage.js';
import type { WorkbenchWorkspaceBinding } from '../types.js';
import {
    type ResolvedWorkbenchReference,
    WorkbenchResolver,
} from '../workbench/index.js';
import { WorkbenchApp } from './app.js';
import { holdRendererUntilShutdown } from './lifecycle.js';
import { ThemeController, ThemeProvider } from './theme/index.js';

export async function renderWorkbenchTui(
    options: {
        initial?: { alias: string; resolved: ResolvedWorkbenchReference };
        environment?: Record<string, string | undefined>;
        workspaces?: WorkbenchWorkspaceBinding[];
    } = {}
): Promise<void> {
    const home = workbenchHome();
    const resolver = new WorkbenchResolver();
    const dispatcher = new RunDispatcher(home);
    const entries = await new SavedWorkbenchCatalog(home).list();
    const recentRuns = (await new RunStore(home).list())
        .filter((run) => run.mode === 'interactive')
        .slice(0, 3);
    const themes = new ThemeController(home);
    await themes.load();
    let finish: () => void = () => {};
    const shutdown = new Promise<void>((resolve) => {
        finish = resolve;
    });
    const renderer = await createCliRenderer({
        screenMode: 'alternate-screen',
        exitOnCtrlC: false,
        clearOnShutdown: true,
        targetFps: 30,
        maxFps: 60,
        useMouse: true,
        backgroundColor: themes.current.background,
        onDestroy: finish,
    });
    if (renderer.themeMode === 'dark' || renderer.themeMode === 'light') {
        themes.setMode(renderer.themeMode);
    }
    await holdRendererUntilShutdown({
        mount: () =>
            render(
                () => (
                    <ThemeProvider controller={themes}>
                        <WorkbenchApp
                            home={home}
                            entries={entries}
                            recentRuns={recentRuns}
                            {...(options.initial ? { initial: options.initial } : {})}
                            resolve={(alias) => resolver.resolve(alias, { home })}
                            start={async ({ resolved, reference }) => {
                                const stored = await dispatcher.prepare({
                                    resolved,
                                    reference,
                                    mode: 'interactive',
                                    workspaces: options.workspaces ?? [],
                                });
                                await dispatcher.dispatch({
                                    id: stored.id,
                                    cwd: resolved.workspaceDirectory,
                                    environment: options.environment ?? process.env,
                                });
                                return dispatcher.handle(stored.id);
                            }}
                        />
                    </ThemeProvider>
                ),
                renderer
            ),
        shutdown,
        destroy: () => renderer.destroy(),
    });
}
