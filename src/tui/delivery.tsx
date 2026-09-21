import { Show } from 'solid-js';
import type { DeliveryTranscriptItem } from './model.js';
import { useTheme } from './theme/index.js';

export function DeliveryCard(props: { item: DeliveryTranscriptItem }) {
    const { theme } = useTheme();
    return (
        <box
            flexDirection="column"
            marginTop={1}
            paddingX={2}
            paddingY={1}
            backgroundColor={theme.backgroundPanel}
            border={['left']}
            borderColor={props.item.state === 'failed' ? theme.red : theme.success}
        >
            <text fg={props.item.state === 'failed' ? theme.red : theme.success}>
                <strong>
                    {props.item.state === 'published'
                        ? props.item.updated
                            ? 'Draft PR updated'
                            : 'Draft PR confirmed'
                        : props.item.state === 'unchanged'
                          ? 'No repository changes to publish'
                          : 'Work saved · PR delivery failed'}
                </strong>
            </text>
            <Show when={props.item.url}>
                <text fg={theme.accent}>
                    <a href={props.item.url ?? ''}>{props.item.url}</a>
                </text>
            </Show>
            <Show when={props.item.message}>
                <text fg={theme.textMuted} wrapMode="word">
                    {props.item.message}
                </text>
            </Show>
            <Show when={props.item.state === 'failed'}>
                <text fg={theme.textMuted} wrapMode="word">
                    Resume the agent to continue GitHub work. Saved result:{' '}
                    {props.item.outcomeId}
                </text>
            </Show>
            <Show when={props.item.url}>
                <text fg={theme.textMuted}>Command-click to view · not merged</text>
            </Show>
        </box>
    );
}
