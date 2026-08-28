import { useRenderer } from '@opentui/solid';
import { createSignal, Match, Switch } from 'solid-js';

import type { CatalogEntry } from '../catalog/index.js';
import type {
    RunnerPermissionDecision,
    RunnerPermissionRequest,
} from '../runners/session.js';
import type { InteractiveRunSession, WorkbenchEvent } from '../runs/index.js';
import type { ResolvedWorkbenchReference } from '../workbench/index.js';
import { ChatScreen } from './chat.js';
import { HomeScreen } from './home.js';
import { theme } from './theme.js';

export { Transcript } from './transcript.js';

export interface TuiAppProps {
    entries: CatalogEntry[];
    initial?: { alias: string; resolved: ResolvedWorkbenchReference };
    resolve: (alias: string) => Promise<ResolvedWorkbenchReference>;
    start: (options: {
        resolved: ResolvedWorkbenchReference;
        reference: string;
        onEvent: (event: WorkbenchEvent) => void;
        onPermission: (
            request: RunnerPermissionRequest
        ) => Promise<RunnerPermissionDecision>;
    }) => Promise<InteractiveRunSession>;
}

export function WorkbenchApp(props: TuiAppProps) {
    const renderer = useRenderer();
    const [screen, setScreen] = createSignal<
        | { kind: 'home' }
        | { kind: 'chat'; alias: string; resolved: ResolvedWorkbenchReference }
    >(
        props.initial
            ? {
                  kind: 'chat',
                  alias: props.initial.alias,
                  resolved: props.initial.resolved,
              }
            : { kind: 'home' }
    );

    const exit = () => renderer.destroy();

    return (
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
                        resolve={props.resolve}
                        onOpen={(alias, resolved) =>
                            setScreen({ kind: 'chat', alias, resolved })
                        }
                        onExit={exit}
                    />
                </Match>
                <Match when={screen().kind === 'chat'}>
                    {(() => {
                        const current = screen();
                        return current.kind === 'chat' ? (
                            <ChatScreen
                                alias={current.alias}
                                resolved={current.resolved}
                                start={props.start}
                                onBack={() => setScreen({ kind: 'home' })}
                                onExit={exit}
                                homeAvailable={!props.initial}
                            />
                        ) : null;
                    })()}
                </Match>
            </Switch>
        </box>
    );
}
