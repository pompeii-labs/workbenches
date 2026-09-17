import { createResource, For, Show } from 'solid-js';
import { formatOutcomeBytes } from '../outcomes/presentation.js';
import { loadOutcomeDialog } from './dialog/outcome.js';
import type { OutcomeTranscriptItem } from './model.js';
import { useTheme } from './theme/index.js';

export function OutcomeCard(props: { item: OutcomeTranscriptItem; home?: string }) {
    const { theme } = useTheme();
    const [results] = createResource(
        () => (props.home ? { home: props.home, id: props.item.outcomeId } : undefined),
        async ({ home, id }) => {
            try {
                return { data: await loadOutcomeDialog(home, id) };
            } catch (cause) {
                return {
                    error: cause instanceof Error ? cause.message : String(cause),
                };
            }
        }
    );
    const healthy = () =>
        props.item.turnIndex !== undefined || props.item.completeness === 'complete';
    const color = () => (healthy() ? theme.success : theme.yellow);
    return (
        <box
            flexDirection="column"
            border={['left']}
            borderColor={color()}
            backgroundColor={theme.backgroundPanel}
            paddingLeft={2}
            paddingRight={1}
            paddingY={1}
            marginTop={1}
        >
            <box flexDirection="row" justifyContent="space-between">
                <text fg={color()}>
                    <strong>
                        {props.item.turnIndex !== undefined
                            ? `Results saved · turn ${props.item.turnIndex}`
                            : props.item.completeness === 'complete'
                              ? 'Outcome ready'
                              : 'Partial outcome available'}
                    </strong>
                </text>
                <text fg={theme.textMuted}>
                    {props.item.turnIndex !== undefined
                        ? 'snapshot'
                        : props.item.applicationState}
                </text>
            </box>
            <Show when={props.item.summary}>
                <text fg={theme.text} wrapMode="word" marginTop={1}>
                    {props.item.summary}
                </text>
            </Show>
            <text fg={theme.textMuted} marginTop={1}>
                {counts(props.item)}
            </text>
            <Show when={results.loading}>
                <text fg={theme.textMuted}>Loading returned files...</text>
            </Show>
            <Show when={results()?.error}>
                <text fg={theme.red} wrapMode="word">
                    {results()?.error}
                </text>
            </Show>
            <For each={results()?.data?.artifacts}>
                {(artifact) => (
                    <text fg={theme.accent} wrapMode="word">
                        <a href={artifact.uri}>{artifact.name}</a> ·{' '}
                        {formatOutcomeBytes(artifact.size)}
                    </text>
                )}
            </For>
            <For each={results()?.data?.outcome.links}>
                {(link) => (
                    <text fg={theme.accent} wrapMode="word">
                        <a href={link.uri}>{link.label}</a>
                    </text>
                )}
            </For>
            <Show
                when={
                    results()?.data &&
                    (props.item.artifacts > 0 || props.item.links > 0)
                }
            >
                <text fg={theme.textMuted}>Command-click to open</text>
            </Show>
            <text fg={theme.faint}>/outcome · {props.item.outcomeId}</text>
        </box>
    );
}

function counts(item: OutcomeTranscriptItem): string {
    const plural = (count: number, singular: string) =>
        `${count} ${singular}${count === 1 ? '' : 's'}`;
    return [
        ...(item.turnIndex === undefined ? [plural(item.changesets, 'changeset')] : []),
        plural(item.artifacts, 'artifact'),
        plural(item.links, 'link'),
        ...(item.warnings > 0 ? [plural(item.warnings, 'warning')] : []),
    ].join(' · ');
}
