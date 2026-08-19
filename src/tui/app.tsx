import { type InputRenderable, SyntaxStyle } from '@opentui/core';
import { useKeyboard, useRenderer } from '@opentui/solid';
import {
    type Accessor,
    createMemo,
    createSignal,
    For,
    Match,
    onCleanup,
    onMount,
    Show,
    Switch,
} from 'solid-js';

import type { CatalogEntry } from '../catalog.js';
import type { WorkbenchEvent } from '../execution.js';
import type { InteractiveWorkbenchSession } from '../interactive.js';
import type { ResolvedReference } from '../references.js';
import type {
    RunnerPermissionDecision,
    RunnerPermissionRequest,
} from '../runner-session.js';
import { renderMarkdownPreview, sanitizeMarkdown } from '../terminal-markdown.js';
import {
    addUserMessage,
    emptyTranscript,
    reduceTranscript,
    TranscriptEventBuffer,
    type TranscriptItem,
} from './model.js';

const theme = {
    background: '#101014',
    panel: '#17171d',
    panelRaised: '#1e1e26',
    text: '#f1efe8',
    muted: '#85838e',
    faint: '#55535f',
    accent: '#a58af9',
    accentSoft: '#332c4d',
    mint: '#72d6b4',
    yellow: '#e7bd72',
    red: '#f07f8f',
} as const;

const markdownStyle = SyntaxStyle.fromStyles({
    default: { fg: theme.text },
    conceal: { fg: theme.faint, dim: true },
    'markup.heading': { fg: theme.accent, bold: true },
    'markup.heading.1': { fg: theme.accent, bold: true },
    'markup.heading.2': { fg: theme.mint, bold: true },
    'markup.heading.3': { fg: theme.text, bold: true },
    'markup.list': { fg: theme.accent },
    'markup.raw': { fg: theme.mint },
    'markup.strong': { fg: theme.text, bold: true },
    'markup.italic': { fg: theme.text, italic: true },
    'markup.strikethrough': { fg: theme.muted, dim: true },
    'markup.link': { fg: theme.accent, underline: true },
    'markup.link.label': { fg: theme.accent, underline: true },
    'markup.link.url': { fg: theme.faint, dim: true },
    'markup.quote': { fg: theme.muted, italic: true },
});

export interface TuiAppProps {
    entries: CatalogEntry[];
    initial?: { alias: string; resolved: ResolvedReference };
    resolve: (alias: string) => Promise<ResolvedReference>;
    start: (options: {
        resolved: ResolvedReference;
        onEvent: (event: WorkbenchEvent) => void;
        onPermission: (
            request: RunnerPermissionRequest
        ) => Promise<RunnerPermissionDecision>;
    }) => Promise<InteractiveWorkbenchSession>;
}

export function WorkbenchApp(props: TuiAppProps) {
    const renderer = useRenderer();
    const [screen, setScreen] = createSignal<
        { kind: 'home' } | { kind: 'chat'; alias: string; resolved: ResolvedReference }
    >(
        props.initial
            ? {
                  kind: 'chat',
                  alias: props.initial.alias,
                  resolved: props.initial.resolved,
              }
            : { kind: 'home' }
    );

    const exit = () => renderer.destroy();

    return (
        <box
            width="100%"
            height="100%"
            backgroundColor={theme.background}
            flexDirection="column"
        >
            <Switch>
                <Match when={screen().kind === 'home'}>
                    <Home
                        entries={props.entries}
                        resolve={props.resolve}
                        onOpen={(alias, resolved) =>
                            setScreen({ kind: 'chat', alias, resolved })
                        }
                        onExit={exit}
                    />
                </Match>
                <Match when={screen().kind === 'chat'}>
                    {(() => {
                        const current = screen();
                        return current.kind === 'chat' ? (
                            <Chat
                                alias={current.alias}
                                resolved={current.resolved}
                                start={props.start}
                                onBack={() => setScreen({ kind: 'home' })}
                                onExit={exit}
                                homeAvailable={!props.initial}
                            />
                        ) : null;
                    })()}
                </Match>
            </Switch>
        </box>
    );
}

function Home(props: {
    entries: CatalogEntry[];
    resolve: (alias: string) => Promise<ResolvedReference>;
    onOpen: (alias: string, resolved: ResolvedReference) => void;
    onExit: () => void;
}) {
    const [query, setQuery] = createSignal('');
    const [selected, setSelected] = createSignal(0);
    const [status, setStatus] = createSignal('');
    const filterEntries = (value: string) => {
        const needle = value.trim().toLowerCase();
        return needle
            ? props.entries.filter((entry) =>
                  [entry.alias, entry.name, entry.source].some((value) =>
                      value.toLowerCase().includes(needle)
                  )
              )
            : props.entries;
    };
    const [filtered, setFiltered] = createSignal(props.entries);
    const current = createMemo(() => filtered()[selected()]);
    const open = async () => {
        const entry = current();
        if (!entry) return;
        setStatus(`Opening ${entry.alias}…`);
        try {
            props.onOpen(entry.alias, await props.resolve(entry.alias));
        } catch (error) {
            setStatus(error instanceof Error ? error.message : String(error));
        }
    };

    useKeyboard((key) => {
        if (key.name === 'escape' || (key.ctrl && key.name === 'c')) {
            props.onExit();
            return;
        }
        if (key.name === 'up') {
            key.preventDefault();
            setSelected((value) => Math.max(0, value - 1));
        }
        if (key.name === 'down') {
            key.preventDefault();
            setSelected((value) => Math.min(filtered().length - 1, value + 1));
        }
    });
    return (
        <box flexDirection="column" flexGrow={1} paddingX={3} paddingY={2}>
            <box flexDirection="row" justifyContent="space-between" marginBottom={2}>
                <box flexDirection="column">
                    <text fg={theme.accent}>
                        <strong>◆ WORKBENCH</strong>
                    </text>
                    <text fg={theme.muted}>Expert systems, ready to run.</text>
                </box>
                <text fg={theme.faint}>v0 · local</text>
            </box>

            <box flexDirection="row" gap={2} flexGrow={1}>
                <box
                    width="42%"
                    flexDirection="column"
                    border={true}
                    borderStyle="rounded"
                    borderColor={theme.faint}
                    backgroundColor={theme.panel}
                    padding={1}
                >
                    <box
                        flexDirection="row"
                        backgroundColor={theme.panelRaised}
                        paddingX={1}
                        marginBottom={1}
                    >
                        <text fg={theme.muted}>⌕ </text>
                        <input
                            id="home-search"
                            ref={(value) => {
                                value.focus();
                            }}
                            value={query()}
                            on:input={(value: string) => {
                                setQuery(value);
                                setFiltered(filterEntries(value));
                                setSelected(0);
                            }}
                            on:enter={() => void open()}
                            placeholder="Find a Workbench"
                            placeholderColor={theme.faint}
                            textColor={theme.text}
                            focusedTextColor={theme.text}
                            backgroundColor={theme.panelRaised}
                            focusedBackgroundColor={theme.panelRaised}
                            flexGrow={1}
                        />
                    </box>
                    <text fg={theme.muted} marginBottom={1}>
                        SAVED · {filtered().length}
                    </text>
                    <Show
                        when={filtered().length > 0}
                        fallback={
                            <text fg={theme.faint}>No matching Workbenches.</text>
                        }
                    >
                        <For each={filtered()}>
                            {(entry, index) => (
                                <box
                                    flexDirection="row"
                                    paddingX={1}
                                    backgroundColor={
                                        index() === selected()
                                            ? theme.accentSoft
                                            : theme.panel
                                    }
                                >
                                    <text
                                        fg={
                                            index() === selected()
                                                ? theme.accent
                                                : theme.faint
                                        }
                                    >
                                        {index() === selected() ? '●' : '○'}{' '}
                                    </text>
                                    <text fg={theme.text}>{entry.alias}</text>
                                </box>
                            )}
                        </For>
                    </Show>
                </box>

                <box
                    flexGrow={1}
                    flexDirection="column"
                    border={true}
                    borderStyle="rounded"
                    borderColor={theme.faint}
                    backgroundColor={theme.panel}
                    padding={2}
                >
                    <Show
                        when={current()}
                        fallback={
                            <box
                                flexGrow={1}
                                justifyContent="center"
                                alignItems="center"
                            >
                                <text fg={theme.faint}>Save a Workbench to begin.</text>
                            </box>
                        }
                    >
                        {(entry: Accessor<CatalogEntry>) => (
                            <>
                                <text fg={theme.accent} marginBottom={1}>
                                    <strong>{entry().alias}</strong>
                                </text>
                                <text fg={theme.text}>{entry().name}</text>
                                <text fg={theme.muted}>version {entry().version}</text>
                                <box height={1} />
                                <text fg={theme.faint}>SOURCE</text>
                                <text fg={theme.muted}>{entry().source}</text>
                                <text fg={theme.faint} marginTop={1}>
                                    REVISION
                                </text>
                                <text fg={theme.muted}>
                                    {entry().revision?.slice(0, 12) ?? 'local snapshot'}
                                </text>
                                <box flexGrow={1} />
                                <text fg={theme.mint}>↵ Open Workbench</text>
                            </>
                        )}
                    </Show>
                </box>
            </box>

            <box flexDirection="row" justifyContent="space-between" marginTop={1}>
                <text fg={status() ? theme.red : theme.faint}>{status()}</text>
                <text fg={theme.faint}>↑↓ navigate · enter open · esc quit</text>
            </box>
        </box>
    );
}

function Chat(props: {
    alias: string;
    resolved: ResolvedReference;
    start: TuiAppProps['start'];
    onBack: () => void;
    onExit: () => void;
    homeAvailable: boolean;
}) {
    const [state, setState] = createSignal(emptyTranscript());
    const [error, setError] = createSignal('');
    const [permission, setPermission] = createSignal<{
        request: RunnerPermissionRequest;
        resolve: (decision: RunnerPermissionDecision) => void;
    }>();
    let session: InteractiveWorkbenchSession | undefined;
    let composer!: InputRenderable;
    let leaving = false;
    const events = new TranscriptEventBuffer((event) =>
        setState((current) => reduceTranscript(current, event))
    );

    const decidePermission = (decision: RunnerPermissionDecision) => {
        const pending = permission();
        if (!pending) return;
        setPermission(undefined);
        setState((current) => ({ ...current, status: 'Working' }));
        pending.resolve(decision);
    };
    const close = async (back: boolean) => {
        if (leaving) return;
        leaving = true;
        decidePermission('reject');
        await session?.close().catch(() => {});
        await props.resolved.cleanup();
        if (back) props.onBack();
        else props.onExit();
    };
    const submit = async (value: string) => {
        const task = value.trim();
        if (!task || !session || state().busy || permission()) return;
        composer.value = '';
        setState((current) => addUserMessage(current, task));
        try {
            await session.send(task);
        } catch (cause) {
            const message = cause instanceof Error ? cause.message : String(cause);
            setError(message);
            setState((current) => ({ ...current, busy: false, status: 'Failed' }));
        }
    };

    onMount(async () => {
        try {
            session = await props.start({
                resolved: props.resolved,
                onEvent: (event) => events.push(event),
                onPermission: (request) =>
                    new Promise((resolve) => {
                        setPermission({ request, resolve });
                    }),
            });
            composer?.focus();
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
            setState((current) => ({ ...current, status: 'Failed' }));
        }
    });
    onCleanup(() => {
        events.dispose();
        if (!leaving) {
            leaving = true;
            decidePermission('reject');
            void session?.close();
            void props.resolved.cleanup();
        }
    });
    useKeyboard((key) => {
        const pending = permission();
        if (pending) {
            if (key.ctrl && key.name === 'c') {
                key.preventDefault();
                decidePermission('reject');
                void session?.cancelTurn();
                return;
            }
            if (key.name === 'y') {
                key.preventDefault();
                decidePermission('allow_once');
                return;
            }
            if (key.name === 'a' && pending.request.allowAlways) {
                key.preventDefault();
                decidePermission('allow_always');
                return;
            }
            if (key.name === 'n' || key.name === 'escape') {
                key.preventDefault();
                decidePermission('reject');
                return;
            }
        }
        if (key.ctrl && key.name === 'c') {
            key.preventDefault();
            if (state().busy) void session?.cancelTurn();
            else void close(false);
        } else if (key.name === 'escape' && props.homeAvailable && !state().busy) {
            key.preventDefault();
            void close(true);
        }
    });

    const manifest = props.resolved.workbench.manifest;
    return (
        <box flexDirection="column" flexGrow={1} paddingX={3} paddingY={1}>
            <box
                flexDirection="row"
                justifyContent="space-between"
                border={['bottom']}
                borderColor={theme.faint}
                paddingBottom={1}
            >
                <box flexDirection="row" gap={1}>
                    <text fg={theme.accent}>◆</text>
                    <text fg={theme.text}>
                        <strong>{props.alias}</strong>
                    </text>
                    <text fg={theme.muted}>· {manifest.name}</text>
                </box>
                <text fg={theme.muted}>
                    {manifest.runner} · {manifest.model} · {manifest.runtime}
                </text>
            </box>

            <scrollbox
                flexGrow={1}
                stickyScroll={true}
                stickyStart="bottom"
                paddingX={1}
                paddingY={1}
            >
                <Show
                    when={state().items.length === 0 && !error()}
                    fallback={<box height={0} />}
                >
                    <box flexDirection="column" paddingTop={2}>
                        <text fg={theme.muted}>Ready when you are.</text>
                        <text fg={theme.faint}>
                            This session keeps its context across every turn.
                        </text>
                    </box>
                </Show>
                <For each={state().items} fallback={<box height={0} />}>
                    {(item, index) => (
                        <Transcript
                            item={item}
                            streaming={
                                item.kind === 'assistant' &&
                                state().busy &&
                                index() === state().items.length - 1
                            }
                        />
                    )}
                </For>
                <Show when={error().length > 0} fallback={<box height={0} />}>
                    <box
                        border={['left']}
                        borderColor={theme.red}
                        paddingLeft={1}
                        marginY={1}
                    >
                        <text fg={theme.red}>{error()}</text>
                    </box>
                </Show>
            </scrollbox>

            <Show
                when={permission()}
                fallback={
                    <box
                        border={true}
                        borderStyle="rounded"
                        borderColor={state().busy ? theme.faint : theme.accent}
                        backgroundColor={theme.panelRaised}
                        paddingX={1}
                        flexDirection="row"
                    >
                        <text fg={state().busy ? theme.faint : theme.accent}>› </text>
                        <input
                            ref={(value) => {
                                composer = value;
                                value.focus();
                            }}
                            placeholder={
                                state().busy ? 'Workbench is working…' : 'Ask anything'
                            }
                            placeholderColor={theme.faint}
                            textColor={theme.text}
                            focusedTextColor={theme.text}
                            backgroundColor={theme.panelRaised}
                            focusedBackgroundColor={theme.panelRaised}
                            flexGrow={1}
                            on:enter={(value: string) => void submit(value)}
                        />
                    </box>
                }
            >
                {(
                    pending: Accessor<{
                        request: RunnerPermissionRequest;
                        resolve: (decision: RunnerPermissionDecision) => void;
                    }>
                ) => (
                    <box
                        height={5}
                        border={true}
                        borderStyle="rounded"
                        borderColor={theme.yellow}
                        backgroundColor={theme.panelRaised}
                        paddingX={1}
                        flexDirection="column"
                    >
                        <text fg={theme.yellow} wrapMode="word">
                            ? {pending().request.message}
                        </text>
                        <text fg={theme.faint}>
                            y allow once
                            {pending().request.allowAlways ? ' · a always allow' : ''} ·
                            n deny
                        </text>
                    </box>
                )}
            </Show>
            <box flexDirection="row" justifyContent="space-between" marginTop={1}>
                <text fg={state().status === 'Failed' ? theme.red : theme.mint}>
                    {state().busy ? '◌' : '●'} {state().status}
                </text>
                <text fg={theme.faint}>
                    {usageLabel(state().totalTokens, state().costUsd)}
                    {state().busy ? 'ctrl+c cancel' : 'enter send · ctrl+c quit'}
                </text>
            </box>
        </box>
    );
}

export function Transcript(props: { item: TranscriptItem; streaming: boolean }) {
    return (
        <Switch>
            <Match when={props.item.kind === 'user'}>
                <box flexDirection="column" marginY={1}>
                    <text fg={theme.accent}>YOU</text>
                    <text fg={theme.text} wrapMode="word">
                        {props.item.kind === 'user' ? props.item.text : ''}
                    </text>
                </box>
            </Match>
            <Match when={props.item.kind === 'assistant'}>
                <box flexDirection="column" marginY={1}>
                    <text fg={theme.mint}>WORKBENCH</text>
                    <Show
                        when={!props.streaming}
                        fallback={
                            <text fg={theme.text} wrapMode="word">
                                {props.item.kind === 'assistant'
                                    ? renderMarkdownPreview(props.item.text)
                                    : ''}
                            </text>
                        }
                    >
                        <markdown
                            content={
                                props.item.kind === 'assistant'
                                    ? tuiMarkdown(props.item.text)
                                    : ''
                            }
                            syntaxStyle={markdownStyle}
                            fg={theme.text}
                            conceal={true}
                            concealCode={true}
                            streaming={false}
                            internalBlockMode="top-level"
                            tableOptions={{
                                style: 'columns',
                                widthMode: 'full',
                                wrapMode: 'word',
                                cellPaddingX: 1,
                            }}
                            width="100%"
                        />
                    </Show>
                </box>
            </Match>
            <Match when={props.item.kind === 'tool'}>
                {(() => {
                    const item = props.item;
                    if (item.kind !== 'tool') return null;
                    return (
                        <box flexDirection="column" marginLeft={1}>
                            <box flexDirection="row">
                                <text
                                    fg={
                                        item.status === 'failed'
                                            ? theme.red
                                            : item.status === 'completed'
                                              ? theme.mint
                                              : theme.yellow
                                    }
                                >
                                    {item.status === 'completed'
                                        ? '✓'
                                        : item.status === 'failed'
                                          ? '✗'
                                          : '→'}{' '}
                                </text>
                                <text fg={theme.muted}>{item.title}</text>
                                <Show when={item.target}>
                                    <text fg={theme.faint}> · {item.target}</text>
                                </Show>
                            </box>
                            <Show when={item.detail}>
                                <text fg={theme.red}> {item.detail}</text>
                            </Show>
                        </box>
                    );
                })()}
            </Match>
            <Match when={props.item.kind === 'notice'}>
                <text
                    fg={
                        props.item.kind === 'notice' && props.item.tone === 'error'
                            ? theme.red
                            : theme.muted
                    }
                >
                    {props.item.kind === 'notice' ? props.item.text : ''}
                </text>
            </Match>
        </Switch>
    );
}

function tuiMarkdown(value: string): string {
    let fence: { marker: string; length: number } | undefined;
    return sanitizeMarkdown(value)
        .split('\n')
        .map((line) => {
            const candidate = /^[ \t]{0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
            if (fence) {
                const run = candidate?.[1] ?? '';
                if (
                    run.startsWith(fence.marker) &&
                    run.length >= fence.length &&
                    (candidate?.[2] ?? '').trim() === ''
                ) {
                    fence = undefined;
                }
                return line;
            }
            if (candidate?.[1]) {
                fence = {
                    marker: candidate[1][0] ?? '`',
                    length: candidate[1].length,
                };
                return line;
            }
            return line.replace(
                /^(\s*[-+*]\s+)\[([ xX])\]\s+/u,
                (_match, marker: string, checked: string) =>
                    `${marker}${checked.toLowerCase() === 'x' ? '✓' : '○'} `
            );
        })
        .join('\n');
}

function usageLabel(tokens: number | undefined, cost: number | undefined): string {
    const details: string[] = [];
    if (tokens !== undefined) details.push(`${tokens.toLocaleString()} tokens`);
    if (cost !== undefined) details.push(`$${cost.toFixed(4)}`);
    return details.length ? `${details.join(' · ')} · ` : '';
}
