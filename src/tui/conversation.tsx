import { type Accessor, Index, Show } from 'solid-js';
import { ActivityIndicator } from './activity.js';
import type { TranscriptDisplayItem } from './model.js';
import { useTheme } from './theme/index.js';
import { Transcript } from './transcript.js';

export function Conversation(props: {
    items: TranscriptDisplayItem[];
    ready: boolean;
    busy: boolean;
    error: string;
    activity: string | undefined;
    assistantLabel: string;
    workspace: string;
    home: string;
}) {
    const { theme } = useTheme();
    return (
        <scrollbox
            flexGrow={1}
            stickyScroll={true}
            stickyStart="bottom"
            paddingX={1}
            paddingY={1}
        >
            <Show
                when={props.items.length === 0 && props.ready && !props.error}
                fallback={<box height={0} />}
            >
                <box flexDirection="column" paddingTop={2}>
                    <text fg={theme.muted}>Ready when you are.</text>
                    <text fg={theme.faint}>
                        This session keeps its context across every turn.
                    </text>
                </box>
            </Show>
            <Index each={props.items} fallback={<box height={0} />}>
                {(item, index) => (
                    <Transcript
                        item={item()}
                        assistantLabel={props.assistantLabel}
                        workspace={props.workspace}
                        home={props.home}
                        streaming={
                            item().kind === 'assistant' &&
                            props.busy &&
                            index === props.items.length - 1
                        }
                    />
                )}
            </Index>
            <Show when={props.activity}>
                {(status: Accessor<string>) => (
                    <box marginTop={1}>
                        <ActivityIndicator label={status()} elapsed={!props.ready} />
                    </box>
                )}
            </Show>
            <Show when={props.error.length > 0} fallback={<box height={0} />}>
                <box
                    border={['left']}
                    borderColor={theme.red}
                    paddingLeft={1}
                    marginTop={1}
                >
                    <text fg={theme.red}>{props.error}</text>
                </box>
            </Show>
        </scrollbox>
    );
}
