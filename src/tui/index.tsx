import { createCliRenderer } from '@opentui/core';
import { render } from '@opentui/solid';

import {
    type AuthoringOperation,
    type AuthoringOperationResult,
    WorkbenchAuthoring,
} from '../authoring/index.js';
import { SavedWorkbenchCatalog } from '../catalog/index.js';
import { RegistryClient, RegistryWorkbenchSaver } from '../registry/index.js';
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
import { ThemeController, ThemeProvider, type WorkbenchTheme } from './theme/index.js';

export interface WorkbenchTuiResult {
    authoringResults: AuthoringOperationResult[];
    theme: WorkbenchTheme;
    sessionId?: string;
}

export async function renderWorkbenchTui(
    options: {
        initial?: {
            alias: string;
            resolved: ResolvedWorkbenchReference;
            session?: StoredSession;
            prompt?: string;
            operation?: AuthoringOperation;
            environment?: Record<string, string | undefined>;
            connection?: string;
        };
        environment?: Record<string, string | undefined>;
        workspaces?: WorkbenchWorkspaceBinding[];
        allowHostDocker?: boolean;
    } = {}
): Promise<WorkbenchTuiResult> {
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
    let sessionId: string | undefined;
    const resolver = new WorkbenchResolver();
    const registry = new RegistryClient();
    const registrySaver = new RegistryWorkbenchSaver(home, { client: registry });
    const sessionResolver = new SessionResolver(home);
    const continuation = new RunContinuation(home);
    const workspace = options.initial?.resolved.workspaceDirectory ?? process.cwd();
    const entries = await new SavedWorkbenchCatalog(home).list();
    const recentSessions = await new SessionStore(home).list({
        resumableOnly: true,
        workspace,
    });
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
                            plainBranding={
                                process.env.NO_COLOR !== undefined ||
                                process.env.TERM === 'dumb'
                            }
                            {...(options.initial ? { initial: options.initial } : {})}
                            resolve={(alias) =>
                                resolver.resolve(alias, {
                                    home,
                                    workspaceDirectory: workspace,
                                })
                            }
                            searchRegistry={(query) => registry.discover(query)}
                            saveRegistry={(workbench) =>
                                registrySaver.save(workbench.reference)
                            }
                            resolveSession={(id) => sessionResolver.resolve(id)}
                            listSessions={(selectedWorkspace) =>
                                new SessionStore(home).list({
                                    resumableOnly: true,
                                    workspace: selectedWorkspace ?? workspace,
                                })
                            }
                            createWorkbench={() =>
                                authoring.create({ directory: workspace })
                            }
                            improveWorkbench={(sessionId, feedback) =>
                                authoring.create({ from: sessionId, feedback })
                            }
                            start={(launch) => {
                                const { authoring: creator, ...run } = launch;
                                if (creator && run.session) {
                                    throw new Error(
                                        'A creator launch must start a fresh Workbench session'
                                    );
                                }
                                return continuation.open({
                                    ...run,
                                    environment:
                                        run.environment ??
                                        options.environment ??
                                        process.env,
                                    workspaces: creator
                                        ? []
                                        : (options.workspaces ?? []),
                                    allowHostDocker: creator
                                        ? false
                                        : (options.allowHostDocker ?? false),
                                    ...(run.connection
                                        ? { connection: run.connection }
                                        : {}),
                                });
                            }}
                            onAuthoringFinished={(result) => results.push(result)}
                            onSessionObserved={(id) => {
                                sessionId = id;
                            }}
                        />
                    </ThemeProvider>
                ),
                renderer
            ),
        shutdown,
        destroy: () => renderer.destroy(),
    });
    return {
        authoringResults: results,
        theme: themes.current,
        ...(sessionId ? { sessionId } : {}),
    };
}
