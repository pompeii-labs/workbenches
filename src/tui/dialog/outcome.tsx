import { pathToFileURL } from 'node:url';
import type { ScrollBoxRenderable } from '@opentui/core';
import { useKeyboard, useTerminalDimensions } from '@opentui/solid';
import { For, Show } from 'solid-js';
import type { RunOutcome } from '../../outcomes/contracts.js';
import { formatOutcomeBytes as formatBytes } from '../../outcomes/presentation.js';
import { OutcomeStore } from '../../outcomes/store.js';
import type { TranscriptState } from '../model.js';
import { useTheme } from '../theme/index.js';
import type { DialogContextValue } from './index.js';

export interface OutcomeDialogData {
    outcome: RunOutcome;
    state: string;
    artifacts: Array<{ name: string; uri: string; size: number }>;
}

export function showTranscriptOutcome(
    home: string,
    transcript: Pick<TranscriptState, 'items'>,
    dialog: DialogContextValue,
    setError: (message: string) => void
): Promise<void> {
    const id = transcript.items
        .toReversed()
        .find((item) => item.kind === 'outcome')?.outcomeId;
    return showOutcomeDialog(home, id, dialog, setError);
}

export async function showOutcomeDialog(
    home: string,
    id: string | undefined,
    dialog: DialogContextValue,
    setError: (message: string) => void
): Promise<void> {
    if (!id) {
        setError('This run does not have an outcome yet.');
        return;
    }
    try {
        const data = await loadOutcomeDialog(home, id);
        dialog.open(() => <OutcomeDialog data={data} />);
        setError('');
    } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
    }
}

export async function loadOutcomeDialog(
    home: string,
    id: string
): Promise<OutcomeDialogData> {
    const store = new OutcomeStore(home);
    const [outcome, receipt] = await Promise.all([store.read(id), store.receipt(id)]);
    const paths = await store.artifactPaths(id);
    return {
        outcome,
        state: receipt.state,
        artifacts: outcome.artifacts.map((artifact) => ({
            name: artifact.name,
            size: artifact.content.size_bytes,
            uri: pathToFileURL(paths.get(artifact.id) as string).href,
        })),
    };
}

export function OutcomeDialog(props: { data: OutcomeDialogData }) {
    const { theme } = useTheme();
    const dimensions = useTerminalDimensions();
    let scroll: ScrollBoxRenderable | undefined;
    useKeyboard((key) => {
        const direction =
            key.name === 'down' || key.name === 'pagedown'
                ? 1
                : key.name === 'up' || key.name === 'pageup'
                  ? -1
                  : 0;
        if (direction) {
            key.preventDefault();
            scroll?.scrollBy(direction * (key.name.startsWith('page') ? 8 : 1));
        }
    });
    const outcome = () => props.data.outcome;
    return (
        <box flexDirection="column" paddingX={3} paddingY={1}>
            <box flexDirection="row" justifyContent="space-between">
                <text fg={theme.text}>
                    <strong>
                        {outcome().turn_index
                            ? `Results · turn ${outcome().turn_index}`
                            : 'Run outcome'}
                    </strong>
                </text>
                <text fg={theme.textMuted}>esc</text>
            </box>
            <scrollbox
                ref={(value) => {
                    scroll = value;
                }}
                maxHeight={Math.max(4, Math.floor(dimensions().height * 0.6) - 4)}
            >
                <text fg={theme.textMuted} marginTop={1}>
                    {outcome().turn_index
                        ? 'Saved snapshot · session can continue'
                        : `${props.data.state} · ${outcome().completeness}`}
                </text>
                <Show when={outcome().summary}>
                    <text fg={theme.text} wrapMode="word">
                        {outcome().summary}
                    </text>
                </Show>
                <For each={outcome().changesets}>
                    {(changeset) => (
                        <box flexDirection="column" marginTop={1}>
                            <text fg={theme.text}>
                                <strong>
                                    {changeset.workspace.kind === 'primary'
                                        ? 'Workspace changes'
                                        : `Changes: ${changeset.workspace.name}`}
                                </strong>
                            </text>
                            <text fg={theme.textMuted}>
                                +{changeset.stats.additions} · ~
                                {changeset.stats.modifications} · -
                                {changeset.stats.deletions}
                            </text>
                            <For each={changeset.entries}>
                                {(entry) => (
                                    <text fg={theme.textMuted}>
                                        {entry.operation} {entry.path}
                                    </text>
                                )}
                            </For>
                        </box>
                    )}
                </For>
                <Show when={props.data.artifacts.length || outcome().links.length}>
                    <text fg={theme.textMuted} marginTop={1}>
                        Command-click a file or link to open it
                    </text>
                </Show>
                <For each={props.data.artifacts}>
                    {(artifact) => (
                        <text fg={theme.accent} wrapMode="word">
                            <a href={artifact.uri}>{artifact.name}</a> ·{' '}
                            {formatBytes(artifact.size)}
                        </text>
                    )}
                </For>
                <For each={outcome().links}>
                    {(link) => (
                        <text fg={theme.accent} wrapMode="word">
                            <a href={link.uri}>{link.label}</a> · {link.kind}
                        </text>
                    )}
                </For>
                <For each={outcome().warnings}>
                    {(warning) => (
                        <text fg={theme.warning} wrapMode="word">
                            {warning.message}
                        </text>
                    )}
                </For>
                <text fg={theme.textMuted} marginTop={1}>
                    wb outcome {outcome().id}
                </text>
                <Show when={props.data.state === 'pending'}>
                    <text fg={theme.textMuted}>
                        Apply explicitly: wb outcome {outcome().id} --apply
                    </text>
                </Show>
                <text fg={theme.textMuted}>
                    Export: wb outcome {outcome().id} --export ./result
                </text>
            </scrollbox>
            <text fg={theme.textMuted} marginTop={1}>
                ↑↓ scroll · esc close
            </text>
        </box>
    );
}
