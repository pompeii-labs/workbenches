import type { TextareaRenderable } from '@opentui/core';
import { createMemo, createSignal, For, Show } from 'solid-js';
import type { TuiCommand, TuiCommandRegistry } from '../commands/registry.js';
import type { QueuedTranscriptInput } from '../model.js';
import { useTheme } from '../theme/index.js';
import type { PromptHistory } from './history.js';

export interface ComposerRef {
    clear(): void;
    focus(): void;
}

export interface ComposerProps {
    busy: boolean;
    disabled: boolean;
    queued: QueuedTranscriptInput[];
    history: PromptHistory;
    commands: TuiCommandRegistry;
    onSubmit: (value: string) => void | Promise<void>;
    onCommand: (command: TuiCommand, argument: string) => void | Promise<void>;
    onUnknownCommand: (name: string) => void;
    onOpenPalette: () => void;
    ref?: (value: ComposerRef) => void;
}

export function Composer(props: ComposerProps) {
    const { theme } = useTheme();
    const [value, setValue] = createSignal('');
    const [selected, setSelected] = createSignal(0);
    let input: TextareaRenderable | undefined;

    const commandQuery = createMemo(() => {
        const current = value().trimStart();
        if (!current.startsWith('/') || current.slice(1).includes(' ')) return;
        return current.slice(1);
    });
    const suggestions = createMemo(() => {
        const query = commandQuery();
        return query === undefined ? [] : props.commands.find(query).slice(0, 6);
    });
    const setText = (text: string) => {
        input?.setText(text);
        input?.gotoBufferEnd();
        setValue(text);
    };
    const clear = () => setText('');
    const complete = () => {
        const command = suggestions()[selected()];
        if (!command) return;
        setText(`/${command.name}${command.usage ? ' ' : ''}`);
    };
    const submit = () => {
        const text = input?.plainText.trim() ?? value().trim();
        if (!text || props.disabled) return;
        if (text.startsWith('/')) {
            const parsed = props.commands.parse(text);
            const suggested = suggestions()[selected()];
            const command = parsed?.command ?? suggested;
            if (!command) {
                props.onUnknownCommand(text.split(/\s/u)[0] ?? text);
                return;
            }
            const argument = parsed?.argument ?? '';
            clear();
            props.history.reset();
            void props.onCommand(command, argument);
            return;
        }

        clear();
        void props.history.append(text);
        void props.onSubmit(text);
    };
    const moveHistory = (direction: 1 | -1) => {
        if (!input || input.lineCount > 1) return false;
        const next = props.history.move(direction, input.plainText);
        if (next === undefined) return false;
        setText(next);
        return true;
    };

    props.ref?.({ clear, focus: () => input?.focus() });

    return (
        <box flexDirection="column" flexShrink={0}>
            <Show when={props.queued.length > 0}>
                <box flexDirection="column" marginBottom={1} paddingX={1}>
                    <For each={props.queued}>
                        {(queued, index) => (
                            <box
                                flexDirection="row"
                                border={['left']}
                                borderColor={theme.secondary}
                                paddingLeft={1}
                            >
                                <text fg={theme.secondary}>QUEUED {index() + 1}</text>
                                <text fg={theme.textMuted} wrapMode="word">
                                    {' '}
                                    {queued.text}
                                </text>
                            </box>
                        )}
                    </For>
                </box>
            </Show>
            <Show when={suggestions().length > 0}>
                <box
                    flexDirection="column"
                    marginLeft={1}
                    marginBottom={1}
                    width={56}
                    maxWidth="90%"
                    backgroundColor={theme.backgroundPanel}
                    border={['left']}
                    borderColor={theme.border}
                >
                    <For each={suggestions()}>
                        {(command, index) => (
                            <box
                                flexDirection="row"
                                justifyContent="space-between"
                                paddingX={1}
                                backgroundColor={
                                    index() === selected()
                                        ? theme.primary
                                        : theme.backgroundPanel
                                }
                            >
                                <text
                                    fg={
                                        index() === selected()
                                            ? theme.background
                                            : theme.text
                                    }
                                >
                                    /{command.name}
                                </text>
                                <text
                                    fg={
                                        index() === selected()
                                            ? theme.background
                                            : theme.textMuted
                                    }
                                >
                                    {command.description}
                                </text>
                            </box>
                        )}
                    </For>
                </box>
            </Show>
            <box
                width="100%"
                border={['left']}
                borderColor={props.busy ? theme.border : theme.primary}
                backgroundColor={theme.backgroundElement}
                paddingX={2}
                paddingY={1}
            >
                <textarea
                    ref={(renderable) => {
                        input = renderable;
                        renderable.traits = { status: 'PROMPT' };
                        setTimeout(() => renderable.focus(), 1);
                    }}
                    width="100%"
                    minHeight={1}
                    maxHeight={8}
                    placeholder={
                        props.busy
                            ? 'Steer the current turn...'
                            : 'Ask anything, or type / for commands'
                    }
                    placeholderColor={theme.textMuted}
                    textColor={theme.text}
                    focusedTextColor={theme.text}
                    backgroundColor={theme.backgroundElement}
                    focusedBackgroundColor={theme.backgroundElement}
                    cursorColor={theme.text}
                    keyBindings={[
                        { name: 'return', action: 'submit' },
                        { name: 'kpenter', action: 'submit' },
                        { name: 'return', shift: true, action: 'newline' },
                        { name: 'kpenter', shift: true, action: 'newline' },
                    ]}
                    onContentChange={() => {
                        setValue(input?.plainText ?? '');
                        setSelected(0);
                        props.history.reset();
                    }}
                    onKeyDown={(key) => {
                        if (props.disabled) {
                            key.preventDefault();
                            return;
                        }
                        if (key.ctrl && key.name === 'k') {
                            key.preventDefault();
                            props.onOpenPalette();
                            return;
                        }
                        if (suggestions().length > 0) {
                            if (key.name === 'up') {
                                key.preventDefault();
                                setSelected(
                                    (current) =>
                                        (current - 1 + suggestions().length) %
                                        suggestions().length
                                );
                                return;
                            }
                            if (key.name === 'down') {
                                key.preventDefault();
                                setSelected(
                                    (current) => (current + 1) % suggestions().length
                                );
                                return;
                            }
                            if (key.name === 'tab') {
                                key.preventDefault();
                                complete();
                                return;
                            }
                        }
                        if (key.name === 'up' && moveHistory(-1)) {
                            key.preventDefault();
                        } else if (key.name === 'down' && moveHistory(1)) {
                            key.preventDefault();
                        }
                    }}
                    onSubmit={submit}
                />
            </box>
            <box flexDirection="row" justifyContent="space-between" paddingX={1}>
                <text fg={theme.textMuted}>shift+enter newline · ctrl+k commands</text>
                <text fg={theme.textMuted}>
                    {props.busy ? 'enter steer' : 'enter send'}
                </text>
            </box>
        </box>
    );
}
