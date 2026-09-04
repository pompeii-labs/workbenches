import { useRenderer } from '@opentui/solid';
import { createMemo, createSignal, Match, Show, Switch } from 'solid-js';

import type { CatalogEntry } from '../catalog/index.js';
import type { RunHandle } from '../runs/index.js';
import type { ResolvedSession, StoredSession } from '../sessions/index.js';
import type { ResolvedWorkbenchReference } from '../workbench/index.js';
import { ChatScreen } from './chat.js';
import { DialogProvider } from './dialog/index.js';
import { HomeScreen } from './home.js';
import { useTheme } from './theme/index.js';

export { Transcript } from './transcript.js';

export interface TuiAppProps {
    home: string;
    entries: CatalogEntry[];
    recentSessions?: StoredSession[];
    initial?: {
        alias: string;
        resolved: ResolvedWorkbenchReference;
        session?: StoredSession;
    };
    resolve: (alias: string) => Promise<ResolvedWorkbenchReference>;
    resolveSession?: (id: string) => Promise<ResolvedSession>;
    start: (options: {
        resolved: ResolvedWorkbenchReference;
        reference: string;
        session?: StoredSession;
    }) => Promise<RunHandle>;
}

interface ChatScreenState {
    kind: 'chat';
    alias: string;
    resolved: ResolvedWorkbenchReference;
    session?: StoredSession;
}

export function WorkbenchApp(props: TuiAppProps) {
    const renderer = useRenderer();
    const { theme } = useTheme();
    const [screen, setScreen] = createSignal<{ kind: 'home' } | ChatScreenState>(
        props.initial
            ? {
                  kind: 'chat',
                  alias: props.initial.alias,
                  resolved: props.initial.resolved,
                  ...(props.initial.session ? { session: props.initial.session } : {}),
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
    const resume = async (session: StoredSession) => {
        if (!props.resolveSession) {
            throw new Error('Session resume is unavailable');
        }
        const target = await props.resolveSession(session.id);
        openSession(target);
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
                            entries={props.entries}
                            {...(props.recentSessions
                                ? { recentSessions: props.recentSessions }
                                : {})}
                            resolve={props.resolve}
                            onResume={resume}
                            onOpen={(alias, resolved) =>
                                setScreen({ kind: 'chat', alias, resolved })
                            }
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
                                    start={props.start}
                                    {...(props.resolveSession
                                        ? { resolveSession: props.resolveSession }
                                        : {})}
                                    onResume={openSession}
                                    onBack={() => setScreen({ kind: 'home' })}
                                    onExit={exit}
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
