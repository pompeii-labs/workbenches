import type { InputRenderable } from '@opentui/core';
import { useKeyboard } from '@opentui/solid';
import { createMemo, createSignal, For, Show } from 'solid-js';
import { useTheme } from '../theme/index.js';
import { useDialog } from './index.js';

export interface SelectDialogOption<T> {
    title: string;
    value: T;
    description?: string;
    category?: string;
    current?: boolean;
    disabled?: boolean;
}

export interface SelectDialogProps<T> {
    title: string;
    placeholder?: string;
    options: SelectDialogOption<T>[];
    onMove?: (option: SelectDialogOption<T>) => void;
    onSelect: (option: SelectDialogOption<T>) => void;
}

export function SelectDialog<T>(props: SelectDialogProps<T>) {
    const dialog = useDialog();
    const { theme } = useTheme();
    const [filter, setFilter] = createSignal('');
    const [selected, setSelected] = createSignal(0);
    const options = createMemo(() => {
        const needle = filter().trim().toLowerCase();
        return props.options.filter((option) => {
            if (option.disabled) return false;
            if (!needle) return true;
            return [option.title, option.description, option.category]
                .filter(Boolean)
                .some((value) => value?.toLowerCase().includes(needle));
        });
    });
    let input: InputRenderable | undefined;

    const move = (direction: number) => {
        const list = options();
        if (list.length === 0) return;
        const next = (selected() + direction + list.length) % list.length;
        setSelected(next);
        const option = list[next];
        if (option) props.onMove?.(option);
    };
    const submit = () => {
        const option = options()[selected()];
        if (!option) return;
        dialog.close();
        props.onSelect(option);
    };

    useKeyboard((key) => {
        if (key.name === 'up') {
            key.preventDefault();
            move(-1);
        } else if (key.name === 'down') {
            key.preventDefault();
            move(1);
        } else if (key.name === 'return') {
            key.preventDefault();
            submit();
        }
    });

    return (
        <box flexDirection="column" paddingY={1}>
            <box flexDirection="row" justifyContent="space-between" paddingX={3}>
                <text fg={theme.text}>
                    <strong>{props.title}</strong>
                </text>
                <text fg={theme.textMuted}>esc</text>
            </box>
            <box paddingX={3} paddingTop={1}>
                <input
                    ref={(value) => {
                        input = value;
                        setTimeout(() => input?.focus(), 1);
                    }}
                    placeholder={props.placeholder ?? 'Search'}
                    placeholderColor={theme.textMuted}
                    textColor={theme.text}
                    focusedTextColor={theme.text}
                    backgroundColor={theme.backgroundPanel}
                    focusedBackgroundColor={theme.backgroundPanel}
                    onInput={(value) => {
                        setFilter(value);
                        setSelected(0);
                    }}
                    onSubmit={submit}
                />
            </box>
            <box height={1} />
            <scrollbox maxHeight={14}>
                <Show
                    when={options().length > 0}
                    fallback={
                        <box paddingX={3}>
                            <text fg={theme.textMuted}>No matching commands.</text>
                        </box>
                    }
                >
                    <For each={options()}>
                        {(option, index) => (
                            <box
                                flexDirection="column"
                                paddingX={3}
                                paddingY={option.description ? 1 : 0}
                                backgroundColor={
                                    index() === selected()
                                        ? theme.primary
                                        : theme.backgroundPanel
                                }
                            >
                                <box flexDirection="row" justifyContent="space-between">
                                    <text
                                        fg={
                                            index() === selected()
                                                ? theme.background
                                                : theme.text
                                        }
                                    >
                                        {option.title}
                                    </text>
                                    <Show when={option.current}>
                                        <text
                                            fg={
                                                index() === selected()
                                                    ? theme.background
                                                    : theme.primary
                                            }
                                        >
                                            current
                                        </text>
                                    </Show>
                                </box>
                                <Show when={option.description}>
                                    <text
                                        fg={
                                            index() === selected()
                                                ? theme.background
                                                : theme.textMuted
                                        }
                                    >
                                        {option.description}
                                    </text>
                                </Show>
                            </box>
                        )}
                    </For>
                </Show>
            </scrollbox>
            <box paddingX={3} paddingTop={1}>
                <text fg={theme.textMuted}>↑↓ navigate · enter select · esc close</text>
            </box>
        </box>
    );
}
