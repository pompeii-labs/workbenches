import {
    decodePasteBytes,
    type PasteEvent,
    type TextareaRenderable,
} from '@opentui/core';
import { createMemo, createSignal, For, onCleanup, Show } from 'solid-js';
import type { TuiCommand, TuiCommandRegistry } from '../commands/registry.js';
import type { QueuedTranscriptInput } from '../model.js';
import { useTheme } from '../theme/index.js';
import type { PromptImageAttachment } from './attachments.js';
import type { PromptHistory } from './history.js';

export interface ComposerRef {
    clear(): void;
    focus(): void;
}

export interface ComposerProps {
    busy: boolean;
    disabled: boolean;
    acceptsImages: boolean;
    queued: QueuedTranscriptInput[];
    attachments: PromptImageAttachment[];
    history: PromptHistory;
    commands: TuiCommandRegistry;
    onSubmit: (value: string) => void | Promise<void>;
    onPaste: (value: string) => Promise<boolean>;
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
    let focusTimer: ReturnType<typeof setTimeout> | undefined;

    onCleanup(() => {
        if (focusTimer) clearTimeout(focusTimer);
    });

    const commandQuery = createMemo(() => {
        const current = value().trimStart();
        if (!current.startsWith('/') || current.slice(1).includes(' ')) return;
        return current.slice(1);
    });
    const suggestions = createMemo(() => {
        const query = commandQuery();
        if (query === undefined) return [];
        const commands = props.commands.find(query);
        return (query ? commands : featureCommands(commands)).slice(0, 8);
    });
    const suggestionNameWidth = createMemo(() =>
        Math.max(12, ...suggestions().map((command) => command.name.length + 3))
    );
    const setText = (text: string) => {
        input?.setText(text);
        input?.gotoBufferEnd();
        setValue(text);
    };
    const clear = () => setText('');
    const complete = (selectedCommand?: TuiCommand) => {
        const command = selectedCommand ?? suggestions()[selected()];
        if (!command) return;
        setText(`/${command.name}${command.usage ? ' ' : ''}`);
    };
    const submit = () => {
        const text = input?.plainText.trim() ?? value().trim();
        if (!text || props.disabled) return;
        if (text.startsWith('/')) {
            const parsed = props.commands.parse(text);
            const commandToken = text.slice(1).split(/\s/u, 1)[0] ?? '';
            const hasArgumentSeparator = /\s/u.test(text.slice(1));
            const exact = props.commands.exact(commandToken);
            const suggested = hasArgumentSeparator
                ? undefined
                : props.commands.find(commandToken).slice(0, 8)[selected()];
            if (suggested && !hasArgumentSeparator && exact !== suggested) {
                if (suggested.usage) {
                    complete(suggested);
                    return;
                }
                clear();
                props.history.reset();
                void props.onCommand(suggested, '');
                return;
            }
            const command = parsed?.command ?? suggested;
            if (!command) {
                props.onUnknownCommand(text.split(/\s/u)[0] ?? text);
                return;
            }
            const argument = parsed?.argument ?? '';
            if (!argument && command.usage?.startsWith('<')) {
                setText(`/${command.name} `);
                return;
            }
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
                                <Show when={queued.images?.length}>
                                    <text fg={theme.secondary}>
                                        {' '}
                                        {queued.images
                                            ?.map((name) => `[image ${name}]`)
                                            .join(' ')}
                                    </text>
                                </Show>
                            </box>
                        )}
                    </For>
                </box>
            </Show>
            <Show when={props.attachments.length > 0}>
                <box flexDirection="row" gap={1} marginBottom={1} paddingX={1}>
                    <text fg={theme.textMuted}>ATTACHED</text>
                    <For each={props.attachments}>
                        {(attachment) => (
                            <text fg={theme.secondary}>[image {attachment.name}]</text>
                        )}
                    </For>
                </box>
            </Show>
            <Show when={suggestions().length > 0}>
                <box
                    flexDirection="column"
                    marginBottom={1}
                    width="100%"
                    backgroundColor={theme.backgroundPanel}
                    border={['left']}
                    borderColor={theme.border}
                >
                    <For each={suggestions()}>
                        {(command, index) => (
                            <box
                                flexDirection="row"
                                paddingX={1}
                                backgroundColor={
                                    index() === selected()
                                        ? theme.primary
                                        : theme.backgroundPanel
                                }
                            >
                                <text
                                    width={suggestionNameWidth()}
                                    flexShrink={0}
                                    wrapMode="none"
                                    fg={
                                        index() === selected()
                                            ? theme.background
                                            : theme.text
                                    }
                                >
                                    /{command.name}
                                </text>
                                <text
                                    flexGrow={1}
                                    wrapMode="none"
                                    fg={
                                        index() === selected()
                                            ? theme.background
                                            : theme.textMuted
                                    }
                                >
                                    {command.title}
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
                        focusTimer = setTimeout(() => {
                            if (!renderable.isDestroyed) renderable.focus();
                        }, 1);
                    }}
                    width="100%"
                    minHeight={1}
                    maxHeight={8}
                    placeholder={
                        props.disabled
                            ? 'Connecting to Workbench...'
                            : props.busy
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
                    onPaste={(event: PasteEvent) => {
                        if (props.disabled) {
                            event.preventDefault();
                            return;
                        }
                        const text = decodePasteBytes(event.bytes)
                            .replace(/\r\n/gu, '\n')
                            .replace(/\r/gu, '\n');
                        event.preventDefault();
                        void props.onPaste(text).then((attached) => {
                            if (attached || !input || input.isDestroyed) return;
                            input.insertText(text);
                        });
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
                <text fg={theme.textMuted}>
                    {props.acceptsImages ? 'drop image · ' : ''}shift+enter newline ·
                    ctrl+k commands
                </text>
                <text fg={theme.textMuted}>
                    {props.busy ? 'enter steer' : 'enter send'}
                </text>
            </box>
        </box>
    );
}

const featuredCommands = [
    'resume',
    'home',
    'rename',
    'improve',
    'clear',
    'permissions',
    'theme',
    'help',
];

function featureCommands(commands: TuiCommand[]): TuiCommand[] {
    const priorities = new Map(
        featuredCommands.map((name, index) => [name, index] as const)
    );
    return commands.toSorted((left, right) => {
        const leftPriority = priorities.get(left.name) ?? featuredCommands.length;
        const rightPriority = priorities.get(right.name) ?? featuredCommands.length;
        return leftPriority - rightPriority || left.name.localeCompare(right.name);
    });
}
