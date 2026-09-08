import { createCliRenderer } from '@opentui/core';
import { render } from '@opentui/solid';

import {
    type AuthoringOperation,
    type AuthoringOperationResult,
    WorkbenchAuthoring,
} from '../authoring/index.js';
import { SavedWorkbenchCatalog } from '../catalog/index.js';
import { RunContinuation } from '../runs/index.js';
import {
    SessionResolver,
    SessionStore,
    type StoredSession,
} from '../sessions/index.js';
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
): Promise<AuthoringOperationResult[]> {
    const home = workbenchHome();
    const authoring = new WorkbenchAuthoring(home, {
        environment: options.environment ?? process.env,
        verification: {
            environment: options.environment ?? process.env,
            ...(options.workspaces ? { workspaces: options.workspaces } : {}),
            ...(options.allowHostDocker !== undefined
                ? { allowHostDocker: options.allowHostDocker }
                : {}),
        },
    });
    const results: AuthoringOperationResult[] = [];
    const resolver = new WorkbenchResolver();
    const sessionResolver = new SessionResolver(home);
    const continuation = new RunContinuation(home);
    const entries = await new SavedWorkbenchCatalog(home).list();
    const recentSessions = (
        await new SessionStore(home).list({ resumableOnly: true })
    ).slice(0, 3);
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
                            recentSessions={recentSessions}
                            {...(options.initial ? { initial: options.initial } : {})}
                            resolve={(alias) => resolver.resolve(alias, { home })}
                            resolveSession={(id) => sessionResolver.resolve(id)}
                            createWorkbench={() =>
                                authoring.create({ directory: process.cwd() })
                            }
                            improveWorkbench={(sessionId, feedback) =>
                                authoring.create({ from: sessionId, feedback })
                            }
                            start={(launch) =>
                                continuation.open({
                                    ...launch,
                                    environment:
                                        launch.environment ??
                                        options.environment ??
                                        process.env,
                                    workspaces: options.workspaces ?? [],
                                    allowHostDocker: options.allowHostDocker ?? false,
                                })
                            }
                            onAuthoringFinished={(result) => results.push(result)}
                        />
                    </ThemeProvider>
                ),
                renderer
            ),
        shutdown,
        destroy: () => renderer.destroy(),
    });
    return results;
}
