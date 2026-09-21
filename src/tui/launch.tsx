import type { InputRenderable } from '@opentui/core';
import { useKeyboard } from '@opentui/solid';
import { createEffect, createSignal, For, Show } from 'solid-js';
import type { RepositoryRequest } from '../repositories/index.js';
import { directorySuggestions, validateLaunchDirectory } from './launchpath.js';
import { RepositoryLaunch } from './repository/launch.js';
import { useTheme } from './theme/index.js';

export type LaunchTarget =
    | { kind: 'current' }
    | { kind: 'directory'; path: string }
    | { kind: 'repository'; request: RepositoryRequest };

const targets = [
    {
        title: 'Current directory',
        detail: 'Use the directory where you opened Workbench',
    },
    {
        title: 'Another directory',
        detail: 'Choose a local project with path completion',
    },
    {
        title: 'GitHub repository',
        detail: 'Use a separate checkout without touching local files',
    },
];

export function LaunchTargetPicker(props: {
    cwd: string;
    onRun: (target: LaunchTarget) => void;
}) {
    const { theme } = useTheme();
    const [mode, setMode] = createSignal<'menu' | 'directory' | 'repository'>('menu');
    const [selected, setSelected] = createSignal(0);
    const [directory, setDirectory] = createSignal('');
    const [suggestions, setSuggestions] = createSignal<string[]>([]);
    const [suggestion, setSuggestion] = createSignal(0);
    const [error, setError] = createSignal('');
    let input: InputRenderable | undefined;
    let sequence = 0;
    let submitted = false;

    createEffect(() => {
        if (mode() !== 'directory') return;
        const value = directory();
        const current = ++sequence;
        void directorySuggestions(props.cwd, value).then((found) => {
            if (current !== sequence) return;
            setSuggestions(found);
            setSuggestion(0);
        });
    });

    const launch = (target: LaunchTarget) => {
        if (submitted) return;
        submitted = true;
        props.onRun(target);
    };
    const choose = () => {
        if (selected() === 0) launch({ kind: 'current' });
        else if (selected() === 1) setMode('directory');
        else setMode('repository');
    };
    const complete = () => {
        const value = suggestions()[suggestion()];
        if (!value) return;
        input?.setText(value);
        input?.gotoBufferEnd();
        setDirectory(value);
        setError('');
    };
    const submitDirectory = async () => {
        try {
            const path = await validateLaunchDirectory(props.cwd, directory());
            launch({ kind: 'directory', path });
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : 'Invalid directory');
        }
    };

    useKeyboard((key) => {
        if (key.defaultPrevented || mode() === 'repository') return;
        if (mode() === 'menu') {
            if (key.name === 'up' || key.name === 'down') {
                key.preventDefault();
                setSelected(
                    (value) =>
                        (value + (key.name === 'down' ? 1 : targets.length - 1)) %
                        targets.length
                );
            } else if (key.name === 'return') {
                key.preventDefault();
                choose();
            }
            return;
        }
        if (key.name === 'tab') {
            key.preventDefault();
            complete();
        } else if (key.name === 'up' || key.name === 'down') {
            key.preventDefault();
            setSuggestion(
                (value) =>
                    (value +
                        (key.name === 'down'
                            ? 1
                            : Math.max(suggestions().length - 1, 0))) %
                    Math.max(suggestions().length, 1)
            );
        } else if (key.name === 'return') {
            key.preventDefault();
            void submitDirectory();
        }
    });

    return (
        <Show
            when={mode() !== 'repository'}
            fallback={
                <RepositoryLaunch
                    onRun={(request) => launch({ kind: 'repository', request })}
                />
            }
        >
            <box flexDirection="column" paddingX={3} paddingY={1}>
                <text fg={theme.text}>
                    <strong>Launch Workbench</strong>
                </text>
                <Show
                    when={mode() === 'menu'}
                    fallback={
                        <box flexDirection="column">
                            <text fg={theme.textMuted} wrapMode="word">
                                Enter a directory, then press Tab to complete a
                                suggestion.
                            </text>
                            <text fg={theme.faint} wrapMode="word">
                                Started in {props.cwd}
                            </text>
                            <input
                                id="launch-directory"
                                ref={(value) => {
                                    input = value;
                                    value.focus();
                                }}
                                value={directory()}
                                onInput={(value) => {
                                    setDirectory(value);
                                    setError('');
                                }}
                                placeholder="./project or ~/project"
                                textColor={theme.text}
                                focusedTextColor={theme.text}
                                backgroundColor={theme.backgroundElement}
                                focusedBackgroundColor={theme.backgroundElement}
                            />
                            <For each={suggestions()}>
                                {(value, index) => (
                                    <text
                                        fg={
                                            index() === suggestion()
                                                ? theme.primary
                                                : theme.textMuted
                                        }
                                    >
                                        {index() === suggestion() ? '› ' : '  '}
                                        {value}
                                    </text>
                                )}
                            </For>
                            <Show when={error()}>
                                <text fg={theme.error} wrapMode="word">
                                    {error()}
                                </text>
                            </Show>
                            <text fg={theme.faint}>
                                ↑↓ suggestions · tab complete · enter run · esc cancel
                            </text>
                        </box>
                    }
                >
                    <box flexDirection="column" marginTop={1}>
                        <For each={targets}>
                            {(target, index) => (
                                <box flexDirection="column" marginBottom={1}>
                                    <text
                                        fg={
                                            index() === selected()
                                                ? theme.primary
                                                : theme.text
                                        }
                                    >
                                        {index() === selected() ? '› ' : '  '}
                                        {target.title}
                                    </text>
                                    <text fg={theme.textMuted}> {target.detail}</text>
                                </box>
                            )}
                        </For>
                        <text fg={theme.faint} wrapMode="word">
                            Current: {props.cwd}
                        </text>
                        <text fg={theme.faint}>
                            ↑↓ choose · enter select · esc cancel
                        </text>
                    </box>
                </Show>
            </box>
        </Show>
    );
}
