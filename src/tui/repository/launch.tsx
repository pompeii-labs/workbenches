import type { InputRenderable } from '@opentui/core';
import { useKeyboard } from '@opentui/solid';
import { createSignal, Show } from 'solid-js';
import {
    parseRepository,
    type RepositoryRequest,
    validRepositoryRef,
} from '../../repositories/index.js';
import { useTheme } from '../theme/index.js';

export function RepositoryLaunch(props: {
    onRun: (request: RepositoryRequest) => void;
}) {
    const { theme } = useTheme();
    const [repository, setRepository] = createSignal('');
    const [branch, setBranch] = createSignal('');
    const [focus, setFocus] = createSignal(0);
    const [error, setError] = createSignal('');
    let target: InputRenderable | undefined;
    let ref: InputRenderable | undefined;
    const submit = () => {
        try {
            const parsed = parseRepository(repository().trim());
            const revision = branch().trim();
            if (revision && !validRepositoryRef(revision))
                throw new Error('Enter a valid branch or Git revision');
            props.onRun({
                repository: `${parsed.owner}/${parsed.name}`,
                ...(revision ? { ref: revision } : {}),
            });
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : 'Invalid repository');
        }
    };
    useKeyboard((key) => {
        if (key.defaultPrevented) return;
        if (key.name === 'tab') {
            key.preventDefault();
            const next = (focus() + 2 + (key.shift ? -1 : 1)) % 2;
            setFocus(next);
            target?.blur();
            ref?.blur();
            if (next === 0) target?.focus();
            if (next === 1) ref?.focus();
        } else if (key.name === 'return') {
            key.preventDefault();
            submit();
        }
    });
    return (
        <box flexDirection="column" paddingX={3} paddingY={1}>
            <text fg={theme.text}>
                <strong>Run on GitHub</strong>
            </text>
            <text fg={theme.textMuted} wrapMode="word">
                A separate checkout. Your current directory is not uploaded or changed.
            </text>
            <text fg={theme.textMuted} marginTop={1}>
                Repository
            </text>
            <input
                id="repository-target"
                ref={(value) => {
                    target = value;
                    value.focus();
                }}
                value={repository()}
                onInput={setRepository}
                placeholder="owner/repo"
                textColor={theme.text}
                focusedTextColor={theme.text}
                backgroundColor={theme.backgroundElement}
                focusedBackgroundColor={theme.backgroundElement}
                onSubmit={submit}
            />
            <text fg={theme.textMuted} marginTop={1}>
                Base branch or revision (optional)
            </text>
            <input
                id="repository-ref"
                ref={(value) => {
                    ref = value;
                }}
                value={branch()}
                onInput={setBranch}
                placeholder="Repository default branch"
                textColor={theme.text}
                focusedTextColor={theme.text}
                backgroundColor={theme.backgroundElement}
                focusedBackgroundColor={theme.backgroundElement}
                onSubmit={submit}
            />
            <text fg={theme.textMuted} wrapMode="word" marginTop={1}>
                Uses your GitHub credential. The agent can use git and gh with its
                actual permissions; Workbench does not publish a PR automatically.
            </text>
            <Show when={error()}>
                <text fg={theme.error} wrapMode="word">
                    {error()}
                </text>
            </Show>
            <text fg={theme.faint}>tab fields · enter run · esc cancel</text>
        </box>
    );
}
