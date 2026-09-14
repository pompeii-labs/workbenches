import { useRenderer } from '@opentui/solid';
import { createMemo, createSignal, Match, Show, Switch } from 'solid-js';
import type {
    AuthoringOperation,
    AuthoringOperationResult,
} from '../authoring/index.js';
import type { CatalogEntry } from '../catalog/index.js';
import type { RegistrySearchResult } from '../registry/index.js';
import type { RunHandle } from '../runs/index.js';
import type { ResolvedSession, StoredSession } from '../sessions/index.js';
import type { ResolvedWorkbenchReference } from '../workbench/index.js';
import { ChatScreen, type PreparedWorkbenchChat } from './chat.js';
import { DialogProvider } from './dialog/index.js';
import { HomeScreen } from './home.js';
import { ResumeScreen } from './resume.js';
import { useTheme } from './theme/index.js';

export { Transcript } from './transcript.js';

export interface TuiAppProps {
    home: string;
    entries: CatalogEntry[];
    recentSessions?: StoredSession[];
    plainBranding?: boolean;
    initial?: {
        alias: string;
        resolved: ResolvedWorkbenchReference;
        session?: StoredSession;
        prompt?: string;
        operation?: AuthoringOperation;
        environment?: Record<string, string | undefined>;
        connection?: string;
    };
    resolve: (alias: string) => Promise<ResolvedWorkbenchReference>;
    searchRegistry?: (query: string) => Promise<RegistrySearchResult[]>;
    saveRegistry?: (workbench: RegistrySearchResult) => Promise<CatalogEntry>;
    resolveSession?: (id: string) => Promise<ResolvedSession>;
    listSessions?: () => Promise<StoredSession[]>;
    createWorkbench?: () => Promise<PreparedWorkbenchChat>;
    improveWorkbench?: (
        sessionId: string,
        feedback: string
    ) => Promise<PreparedWorkbenchChat>;
    start: (options: {
        resolved: ResolvedWorkbenchReference;
        reference: string;
        session?: StoredSession;
        environment?: Record<string, string | undefined>;
        authoring?: boolean;
        connection?: string;
    }) => Promise<RunHandle>;
    onSessionObserved?: (id: string | undefined) => void;
    onAuthoringFinished?: (result: AuthoringOperationResult) => void;
}

interface ChatScreenState {
    kind: 'chat';
    alias: string;
    resolved: ResolvedWorkbenchReference;
    session?: StoredSession;
    prompt?: string;
    operation?: AuthoringOperation;
    environment?: Record<string, string | undefined>;
    connection?: string;
}

export function WorkbenchApp(props: TuiAppProps) {
    const renderer = useRenderer();
    const { theme } = useTheme();
    const createWorkbench = props.createWorkbench;
    const saveRegistry = props.saveRegistry;
    const [entries, setEntries] = createSignal(props.entries);
    const [recentSessions, setRecentSessions] = createSignal(
        props.recentSessions ?? []
    );
    const [screen, setScreen] = createSignal<
        { kind: 'home' } | { kind: 'resume' } | ChatScreenState
    >(
        props.initial
            ? {
                  kind: 'chat',
                  alias: props.initial.alias,
                  resolved: props.initial.resolved,
                  ...(props.initial.session ? { session: props.initial.session } : {}),
                  ...(props.initial.prompt ? { prompt: props.initial.prompt } : {}),
                  ...(props.initial.operation
                      ? { operation: props.initial.operation }
                      : {}),
                  ...(props.initial.environment
                      ? { environment: props.initial.environment }
                      : {}),
                  ...(props.initial.connection
                      ? { connection: props.initial.connection }
                      : {}),
              }
            : { kind: 'home' }
    );

    const exit = () => renderer.destroy();
    const chat = createMemo(() => {
        const current = screen();
        return current.kind === 'chat' ? current : undefined;
    });
    const openSession = (target: ResolvedSession) => {
        setScreen({ kind: 'chat', ...target });
    };
    const openAuthoring = (target: PreparedWorkbenchChat) => {
        setScreen({
            kind: 'chat',
            alias: target.alias,
            resolved: target.resolved,
            ...(target.prompt ? { prompt: target.prompt } : {}),
            ...(target.operation ? { operation: target.operation } : {}),
            ...(target.environment ? { environment: target.environment } : {}),
        });
    };
    const resume = async (session: StoredSession) => {
        if (!props.resolveSession) {
            throw new Error('Session resume is unavailable');
        }
        const target = await props.resolveSession(session.id);
        openSession(target);
    };
    const refreshSessions = async () => {
        if (!props.listSessions) return;
        try {
            setRecentSessions(await props.listSessions());
        } catch {
            // Keep the last known list when local session discovery is unavailable.
        }
    };
    const openHome = () => {
        setScreen({ kind: 'home' });
        void refreshSessions();
    };
    const browseSessions = () => {
        setScreen({ kind: 'resume' });
        void refreshSessions();
    };

    return (
        <DialogProvider>
            <box
                width="100%"
                height="100%"
                backgroundColor={theme.background}
                flexDirection="column"
            >
                <Switch>
                    <Match when={screen().kind === 'home'}>
                        <HomeScreen
                            entries={entries()}
                            {...(props.plainBranding !== undefined
                                ? { plainBranding: props.plainBranding }
                                : {})}
                            resolve={props.resolve}
                            onBrowseSessions={browseSessions}
                            {...(props.searchRegistry
                                ? { searchRegistry: props.searchRegistry }
                                : {})}
                            {...(saveRegistry
                                ? {
                                      onSaveRegistry: async (workbench) => {
                                          const entry = await saveRegistry(workbench);
                                          setEntries((current) => [
                                              ...current.filter(
                                                  (candidate) =>
                                                      candidate.alias !== entry.alias
                                              ),
                                              entry,
                                          ]);
                                          return entry;
                                      },
                                  }
                                : {})}
                            {...(createWorkbench
                                ? {
                                      onCreate: async () =>
                                          openAuthoring(await createWorkbench()),
                                  }
                                : {})}
                            onOpen={(alias, resolved) =>
                                setScreen({ kind: 'chat', alias, resolved })
                            }
                            onExit={exit}
                        />
                    </Match>
                    <Match when={screen().kind === 'resume'}>
                        <ResumeScreen
                            sessions={recentSessions()}
                            onResume={resume}
                            onBack={openHome}
                            onExit={exit}
                        />
                    </Match>
                    <Match when={screen().kind === 'chat'}>
                        <Show when={chat()} keyed>
                            {(current: ChatScreenState) => (
                                <ChatScreen
                                    home={props.home}
                                    alias={current.alias}
                                    resolved={current.resolved}
                                    {...(current.session
                                        ? { session: current.session }
                                        : {})}
                                    {...(current.prompt
                                        ? { initialPrompt: current.prompt }
                                        : {})}
                                    {...(current.operation
                                        ? { operation: current.operation }
                                        : {})}
                                    {...(current.environment
                                        ? { environment: current.environment }
                                        : {})}
                                    {...(current.connection
                                        ? { connection: current.connection }
                                        : {})}
                                    start={props.start}
                                    {...(props.onSessionObserved
                                        ? {
                                              onSessionObserved:
                                                  props.onSessionObserved,
                                          }
                                        : {})}
                                    onSessionUpdated={(session) =>
                                        setRecentSessions((current) =>
                                            session.native_session_id
                                                ? [
                                                      session,
                                                      ...current.filter(
                                                          (candidate) =>
                                                              candidate.id !==
                                                              session.id
                                                      ),
                                                  ]
                                                : current
                                        )
                                    }
                                    {...(props.improveWorkbench
                                        ? {
                                              prepareImprovement:
                                                  props.improveWorkbench,
                                              onAuthoring: openAuthoring,
                                          }
                                        : {})}
                                    onBack={openHome}
                                    onBrowseSessions={browseSessions}
                                    onExit={exit}
                                    {...(props.onAuthoringFinished
                                        ? {
                                              onAuthoringFinished:
                                                  props.onAuthoringFinished,
                                          }
                                        : {})}
                                    homeAvailable={!props.initial}
                                />
                            )}
                        </Show>
                    </Match>
                </Switch>
            </box>
        </DialogProvider>
    );
}
