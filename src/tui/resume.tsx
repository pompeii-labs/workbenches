import type { InputRenderable, KeyEvent } from '@opentui/core';
import { useKeyboard, useTerminalDimensions } from '@opentui/solid';
import { createEffect, createMemo, createSignal, For, Show } from 'solid-js';

import { SessionIdentity, type StoredSession } from '../sessions/index.js';
import { useTheme } from './theme/index.js';

export interface ResumeScreenProps {
    sessions: StoredSession[];
    onResume: (session: StoredSession) => void | Promise<void>;
    onBack: () => void;
    onExit: () => void;
}

export function ResumeScreen(props: ResumeScreenProps) {
    const dimensions = useTerminalDimensions();
    const { theme } = useTheme();
    const identity = new SessionIdentity();
    const [query, setQuery] = createSignal('');
    const [selected, setSelected] = createSignal(0);
    const [status, setStatus] = createSignal<
        { text: string; error: boolean } | undefined
    >();
    const [opening, setOpening] = createSignal(false);
    let input: InputRenderable | undefined;

    const sessions = createMemo(() => {
        const terms = query().toLowerCase().trim().split(/\s+/u).filter(Boolean);
        if (terms.length === 0) return props.sessions;
        return props.sessions.filter((session) => {
            const searchable = [
                identity.label(session),
                session.workbench,
                session.runner,
                session.model,
                session.id,
            ]
                .join(' ')
                .toLowerCase();
            return terms.every((term) => searchable.includes(term));
        });
    });
    const limit = createMemo(() => Math.max(1, dimensions().height - 10));
    const windowStart = createMemo(() =>
        Math.min(
            Math.max(selected() - limit() + 1, 0),
            Math.max(sessions().length - limit(), 0)
        )
    );
    const visible = createMemo(() =>
        sessions().slice(windowStart(), windowStart() + limit())
    );
    const current = createMemo(() => sessions()[selected()]);
    const showDetails = createMemo(() => dimensions().width >= 90);

    createEffect(() => {
        const count = sessions().length;
        if (count === 0) setSelected(0);
        else if (selected() >= count) setSelected(count - 1);
    });

    const updateQuery = (value: string) => {
        setQuery(value);
        setSelected(0);
        setStatus(undefined);
    };
    const move = (direction: number) => {
        const options = sessions();
        if (options.length === 0) return;
        setSelected((value) => (value + direction + options.length) % options.length);
        setStatus(undefined);
    };
    const resume = async () => {
        const session = current();
        if (!session || opening()) return;
        setOpening(true);
        setStatus({ text: `Resuming ${identity.label(session)}...`, error: false });
        try {
            await props.onResume(session);
        } catch (error) {
            setOpening(false);
            setStatus({ text: errorMessage(error), error: true });
            input?.focus();
        }
    };
    const handleKey = (key: KeyEvent) => {
        if (key.name === 'up') {
            key.preventDefault();
            move(-1);
        } else if (key.name === 'down') {
            key.preventDefault();
            move(1);
        } else if (key.name === 'escape') {
            key.preventDefault();
            props.onBack();
        }
    };

    useKeyboard((key) => {
        if (key.ctrl && key.name === 'c') {
            key.preventDefault();
            props.onExit();
        }
    });

    return (
        <box flexDirection="column" flexGrow={1} paddingX={3} paddingY={1}>
            <text fg={theme.primary} marginBottom={1}>
                <strong>Resume a previous session</strong>
            </text>
            <box
                border={['bottom']}
                borderColor={theme.border}
                flexDirection="row"
                justifyContent="space-between"
                paddingBottom={1}
            >
                <input
                    id="resume-search"
                    ref={(value) => {
                        input = value;
                        value.focus();
                    }}
                    value={query()}
                    onInput={updateQuery}
                    onSubmit={() => void resume()}
                    onKeyDown={handleKey}
                    placeholder="Type to search"
                    placeholderColor={theme.textMuted}
                    textColor={theme.text}
                    focusedTextColor={theme.text}
                    cursorColor={theme.text}
                    backgroundColor={theme.background}
                    focusedBackgroundColor={theme.background}
                    flexGrow={1}
                />
                <text fg={theme.faint}>
                    cwd · {sessions().length} session
                    {sessions().length === 1 ? '' : 's'}
                </text>
            </box>

            <box flexDirection="column" flexGrow={1} minHeight={0} paddingTop={1}>
                <Show
                    when={visible().length > 0}
                    fallback={
                        <text fg={theme.textMuted} paddingX={1}>
                            {props.sessions.length === 0
                                ? 'No resumable sessions yet.'
                                : 'No sessions match that search.'}
                        </text>
                    }
                >
                    <For each={visible()}>
                        {(session, index) => {
                            const active = () => index() + windowStart() === selected();
                            return (
                                <box
                                    flexDirection="row"
                                    paddingX={1}
                                    backgroundColor={
                                        active()
                                            ? theme.backgroundElement
                                            : theme.background
                                    }
                                >
                                    <text
                                        width={2}
                                        flexShrink={0}
                                        fg={active() ? theme.primary : theme.faint}
                                    >
                                        {active() ? '›' : ' '}
                                    </text>
                                    <text
                                        width={10}
                                        flexShrink={0}
                                        fg={theme.textMuted}
                                    >
                                        {relativeTime(session.updated_at)}
                                    </text>
                                    <text
                                        flexGrow={1}
                                        truncate={true}
                                        fg={active() ? theme.primary : theme.text}
                                    >
                                        {identity.label(session)}
                                    </text>
                                    <Show when={showDetails()}>
                                        <text
                                            width={38}
                                            flexShrink={0}
                                            truncate={true}
                                            fg={theme.faint}
                                        >
                                            {session.workbench} · {session.runner}
                                        </text>
                                    </Show>
                                </box>
                            );
                        }}
                    </For>
                </Show>
            </box>

            <Show when={status()}>
                <text fg={status()?.error ? theme.error : theme.textMuted}>
                    {status()?.text}
                </text>
            </Show>
            <box
                border={['top']}
                borderColor={theme.border}
                paddingTop={1}
                flexDirection="row"
                justifyContent="space-between"
            >
                <text fg={theme.textMuted}>enter resume · esc home · ctrl+c exit</text>
                <text fg={theme.faint}>
                    {sessions().length === 0 ? '0' : selected() + 1} /{' '}
                    {sessions().length}
                </text>
            </box>
        </box>
    );
}

function relativeTime(timestamp: string): string {
    const milliseconds = Date.now() - Date.parse(timestamp);
    if (!Number.isFinite(milliseconds) || milliseconds < 0) return 'now';
    const minutes = Math.floor(milliseconds / 60_000);
    if (minutes < 1) return 'now';
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
