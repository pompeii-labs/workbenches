import { For, Show } from 'solid-js';

import { useTheme } from '../theme/index.js';

export interface InfoDialogSection {
    label: string;
    value: string;
}

export function InfoDialog(props: {
    title: string;
    description?: string;
    sections?: InfoDialogSection[];
    lines?: string[];
}) {
    const { theme } = useTheme();
    return (
        <box flexDirection="column" paddingX={3} paddingY={1}>
            <box flexDirection="row" justifyContent="space-between">
                <text fg={theme.text}>
                    <strong>{props.title}</strong>
                </text>
                <text fg={theme.textMuted}>esc</text>
            </box>
            <Show when={props.description}>
                <text fg={theme.textMuted} marginTop={1} wrapMode="word">
                    {props.description}
                </text>
            </Show>
            <For each={props.sections ?? []}>
                {(section) => (
                    <box flexDirection="column" marginTop={1}>
                        <text fg={theme.textMuted}>{section.label.toUpperCase()}</text>
                        <text fg={theme.text} wrapMode="word">
                            {section.value}
                        </text>
                    </box>
                )}
            </For>
            <Show when={(props.lines?.length ?? 0) > 0}>
                <box flexDirection="column" marginTop={1}>
                    <For each={props.lines}>
                        {(line) => <text fg={theme.text}>{line}</text>}
                    </For>
                </box>
            </Show>
        </box>
    );
}
