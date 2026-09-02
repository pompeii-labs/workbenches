import { createCliRenderer } from '@opentui/core';
import { render } from '@opentui/solid';

import { SavedWorkbenchCatalog } from '../catalog/index.js';
import { RunDispatcher } from '../runs/index.js';
import { workbenchHome } from '../storage.js';
import type { WorkbenchWorkspaceBinding } from '../types.js';
import {
    type ResolvedWorkbenchReference,
    WorkbenchResolver,
} from '../workbench/index.js';
import { WorkbenchApp } from './app.js';
import { holdRendererUntilShutdown } from './lifecycle.js';

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
        backgroundColor: '#101014',
        onDestroy: finish,
    });
    await holdRendererUntilShutdown({
        mount: () =>
            render(
                () => (
                    <WorkbenchApp
                        entries={entries}
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
                ),
                renderer
            ),
        shutdown,
        destroy: () => renderer.destroy(),
    });
}
