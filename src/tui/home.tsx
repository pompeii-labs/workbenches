import type { ScrollBoxRenderable } from '@opentui/core';
import { useKeyboard, useTerminalDimensions } from '@opentui/solid';
import {
    type Accessor,
    createEffect,
    createMemo,
    createSignal,
    For,
    onCleanup,
    Show,
} from 'solid-js';

import packageMetadata from '../../package.json' with { type: 'json' };
import type { CatalogEntry } from '../catalog/index.js';
import { modelLabel } from '../models/index.js';
import type { StoredSession } from '../sessions/index.js';
import type { ResolvedWorkbenchReference } from '../workbench/index.js';
import { useTheme, type WorkbenchTheme } from './theme/index.js';

export interface HomeScreenProps {
    entries: CatalogEntry[];
    recentSessions?: StoredSession[];
    resolve: (alias: string) => Promise<ResolvedWorkbenchReference>;
    onOpen: (alias: string, resolved: ResolvedWorkbenchReference) => void;
    onResume: (session: StoredSession) => void | Promise<void>;
    onCreate?: () => void | Promise<void>;
    onExit: () => void;
}

interface HomeWorkbenchDetails {
    alias: string;
    description?: string;
    runner: string;
    model: string;
    runtime: string;
    skills: number;
    tools: number;
    mcps: number;
    environment: number;
    workspaces: number;
}

type DetailState =
    | { kind: 'empty' }
    | { kind: 'loading' }
    | { kind: 'ready'; value: HomeWorkbenchDetails }
    | { kind: 'error'; message: string };

class HomeWorkbenchCatalog {
    readonly #details = new Map<string, Promise<HomeWorkbenchDetails>>();

    constructor(
        private readonly resolve: (alias: string) => Promise<ResolvedWorkbenchReference>
    ) {}

    details(entry: CatalogEntry): Promise<HomeWorkbenchDetails> {
        const cached = this.#details.get(entry.alias);
        if (cached) return cached;
        const pending = this.load(entry).catch((error) => {
            this.#details.delete(entry.alias);
            throw error;
        });
        this.#details.set(entry.alias, pending);
        return pending;
    }

    private async load(entry: CatalogEntry): Promise<HomeWorkbenchDetails> {
        const resolved = await this.resolve(entry.alias);
        try {
            const manifest = resolved.workbench.manifest;
            return {
                alias: entry.alias,
                ...(manifest.description ? { description: manifest.description } : {}),
                runner: manifest.runner,
                model: modelLabel(manifest.model),
                runtime: manifest.runtime,
                skills: resolved.workbench.skills.length,
                tools: manifest.tools.length,
                mcps: manifest.mcps.length,
                environment: Object.keys(manifest.env).length,
                workspaces: Object.keys(manifest.workspaces ?? {}).length,
            };
        } finally {
            await resolved.cleanup();
        }
    }
}

export function HomeScreen(props: HomeScreenProps) {
    const dimensions = useTerminalDimensions();
    const { theme } = useTheme();
    const catalog = new HomeWorkbenchCatalog(props.resolve);
    const [query, setQuery] = createSignal('');
    const [selected, setSelected] = createSignal(0);
    const [detail, setDetail] = createSignal<DetailState>({ kind: 'empty' });
    const [status, setStatus] = createSignal<
        { text: string; error: boolean } | undefined
    >();
    const filtered = createMemo(() => filterEntries(props.entries, query()));
    const current = createMemo(() => filtered()[selected()]);
    const wide = createMemo(() => dimensions().width >= 92);
    const showRecent = createMemo(
        () => dimensions().height >= 22 && (props.recentSessions?.length ?? 0) > 0
    );
    let detailRequest = 0;

    createEffect(() => {
        const entry = current();
        const request = ++detailRequest;
        if (!entry) {
            setDetail({ kind: 'empty' });
            return;
        }
        setDetail({ kind: 'loading' });
        void catalog.details(entry).then(
            (value) => {
                if (request === detailRequest) setDetail({ kind: 'ready', value });
            },
            (error) => {
                if (request !== detailRequest) return;
                setDetail({
                    kind: 'error',
                    message: error instanceof Error ? error.message : String(error),
                });
            }
        );
    });
    onCleanup(() => {
        detailRequest += 1;
    });

    const move = (direction: number) => {
        const entries = filtered();
        if (entries.length === 0) return;
        setSelected((value) => (value + direction + entries.length) % entries.length);
        setStatus(undefined);
    };
    const open = async () => {
        const entry = current();
        if (!entry) return;
        setStatus({ text: `Opening ${entry.alias}...`, error: false });
        try {
            props.onOpen(entry.alias, await props.resolve(entry.alias));
        } catch (error) {
            setStatus({
                text: error instanceof Error ? error.message : String(error),
                error: true,
            });
        }
    };
    const resume = async (session: StoredSession | undefined) => {
        if (!session) return;
        setStatus({ text: `Resuming ${session.workbench}...`, error: false });
        try {
            await props.onResume(session);
        } catch (error) {
            setStatus({
                text: error instanceof Error ? error.message : String(error),
                error: true,
            });
        }
    };
    const create = async () => {
        if (!props.onCreate) return;
        setStatus({ text: 'Opening the Workbench creator...', error: false });
        try {
            await props.onCreate();
        } catch (error) {
            setStatus({
                text: error instanceof Error ? error.message : String(error),
                error: true,
            });
        }
    };

    useKeyboard((key) => {
        if (key.ctrl && key.name === 'c') {
            key.preventDefault();
            props.onExit();
            return;
        }
        if (key.ctrl && key.name === 'r') {
            key.preventDefault();
            void resume(props.recentSessions?.[0]);
            return;
        }
        if (key.ctrl && key.name === 'n' && props.onCreate) {
            key.preventDefault();
            void create();
            return;
        }
        if (key.name === 'escape') {
            key.preventDefault();
            if (query()) {
                setQuery('');
                setSelected(0);
                setStatus(undefined);
            } else {
                props.onExit();
            }
            return;
        }
        if (key.name === 'up') {
            key.preventDefault();
            move(-1);
        } else if (key.name === 'down') {
            key.preventDefault();
            move(1);
        }
    });

    return (
        <box flexDirection="column" flexGrow={1} paddingX={wide() ? 3 : 2}>
            <box
                flexDirection="row"
                justifyContent="space-between"
                border={['bottom']}
                borderColor={theme.borderSubtle}
                paddingY={1}
                marginBottom={1}
            >
                <box flexDirection="row" gap={2}>
                    <text fg={theme.accent}>
                        <strong>◆ WORKBENCH</strong>
                    </text>
                    <Show when={wide()}>
                        <text fg={theme.textMuted}>
                            Your saved expert environments.
                        </text>
                    </Show>
                </box>
                <text fg={theme.faint}>v{packageMetadata.version}</text>
            </box>

            <Show when={showRecent()}>
                <RecentActivity
                    sessions={(props.recentSessions ?? []).slice(0, wide() ? 3 : 1)}
                    theme={theme}
                    compact={!wide()}
                    onResume={(session) => void resume(session)}
                />
            </Show>

            <Show
                when={wide()}
                fallback={
                    <box flexDirection="column" flexGrow={1}>
                        <SavedWorkbenchList
                            entries={props.entries}
                            filtered={filtered}
                            query={query}
                            selected={selected}
                            theme={theme}
                            onQuery={(value) => {
                                setQuery(value);
                                setSelected(0);
                                setStatus(undefined);
                            }}
                            onOpen={() => void open()}
                        />
                        <WorkbenchDetails
                            entry={current}
                            detail={detail}
                            theme={theme}
                            compact={true}
                        />
                    </box>
                }
            >
                <box flexDirection="row" flexGrow={1}>
                    <box width="43%" paddingRight={2}>
                        <SavedWorkbenchList
                            entries={props.entries}
                            filtered={filtered}
                            query={query}
                            selected={selected}
                            theme={theme}
                            onQuery={(value) => {
                                setQuery(value);
                                setSelected(0);
                                setStatus(undefined);
                            }}
                            onOpen={() => void open()}
                        />
                    </box>
                    <box
                        flexGrow={1}
                        border={['left']}
                        borderColor={theme.borderSubtle}
                        paddingLeft={3}
                    >
                        <WorkbenchDetails
                            entry={current}
                            detail={detail}
                            theme={theme}
                            compact={false}
                        />
                    </box>
                </box>
            </Show>

            <box flexDirection="row" justifyContent="space-between" marginY={1}>
                <text fg={status()?.error ? theme.error : theme.textMuted}>
                    {status()?.text ?? ''}
                </text>
                <text fg={theme.faint}>
                    {wide()
                        ? '↑↓ navigate · enter open · ctrl+n create · ctrl+r resume latest · esc quit'
                        : '↑↓ navigate · enter open · ctrl+n create · esc quit'}
                </text>
            </box>
        </box>
    );
}

function RecentActivity(props: {
    sessions: StoredSession[];
    theme: WorkbenchTheme;
    compact: boolean;
    onResume: (session: StoredSession) => void;
}) {
    return (
        <box flexDirection="column" height={props.sessions.length + 1} marginBottom={1}>
            <text fg={props.theme.textMuted}>RECENT SESSIONS</text>
            <For each={props.sessions}>
                {(session) => (
                    // biome-ignore lint/a11y/noStaticElementInteractions: OpenTUI boxes support mouse events but do not expose browser roles.
                    <box
                        flexDirection="row"
                        justifyContent="space-between"
                        onMouseUp={() => props.onResume(session)}
                    >
                        <box flexDirection="row" gap={1}>
                            <text fg={props.theme.accent}>◆</text>
                            <text fg={props.theme.text}>{session.workbench}</text>
                            <Show when={!props.compact}>
                                <text fg={props.theme.faint}>
                                    {session.runner} · {session.model}
                                </text>
                            </Show>
                        </box>
                        <text fg={props.theme.textMuted}>
                            resume · {relativeTime(session.updated_at)}
                        </text>
                    </box>
                )}
            </For>
        </box>
    );
}

function SavedWorkbenchList(props: {
    entries: CatalogEntry[];
    filtered: Accessor<CatalogEntry[]>;
    query: Accessor<string>;
    selected: Accessor<number>;
    theme: WorkbenchTheme;
    onQuery: (value: string) => void;
    onOpen: () => void;
}) {
    let list: ScrollBoxRenderable | undefined;
    createEffect(() => {
        const entry = props.filtered()[props.selected()];
        if (!entry) return;
        queueMicrotask(() => {
            if (list && !list.isDestroyed) {
                list.scrollChildIntoView(`home-${entry.alias}`);
            }
        });
    });

    return (
        <box flexDirection="column" flexGrow={1}>
            <box flexDirection="row" justifyContent="space-between">
                <text fg={props.theme.textMuted}>SAVED WORKBENCHES</text>
                <text fg={props.theme.faint}>
                    {selectionPosition(
                        props.selected(),
                        props.filtered().length,
                        props.entries.length
                    )}
                </text>
            </box>
            <box
                flexDirection="row"
                backgroundColor={props.theme.backgroundElement}
                paddingX={1}
                marginY={1}
            >
                <text fg={props.theme.textMuted}>⌕ </text>
                <input
                    id="home-search"
                    ref={(value) => value.focus()}
                    value={props.query()}
                    onInput={props.onQuery}
                    onSubmit={props.onOpen}
                    placeholder="Find a Workbench"
                    placeholderColor={props.theme.faint}
                    textColor={props.theme.text}
                    focusedTextColor={props.theme.text}
                    backgroundColor={props.theme.backgroundElement}
                    focusedBackgroundColor={props.theme.backgroundElement}
                    flexGrow={1}
                />
            </box>
            <Show
                when={props.filtered().length > 0}
                fallback={
                    <box flexDirection="column" paddingX={1} paddingTop={1}>
                        <Show
                            when={props.entries.length > 0}
                            fallback={
                                <>
                                    <text fg={props.theme.text}>
                                        No saved Workbenches.
                                    </text>
                                    <text fg={props.theme.textMuted} marginTop={1}>
                                        wb add owner/repository#name --as name
                                    </text>
                                    <text fg={props.theme.textMuted}>
                                        wb create name
                                    </text>
                                </>
                            }
                        >
                            <text fg={props.theme.textMuted}>
                                No Workbenches match “{props.query()}”.
                            </text>
                            <text fg={props.theme.faint}>Press esc to clear.</text>
                        </Show>
                    </box>
                }
            >
                <scrollbox ref={(value) => (list = value)} flexGrow={1}>
                    <For each={props.filtered()}>
                        {(entry, index) => {
                            const active = () => index() === props.selected();
                            return (
                                <box
                                    id={`home-${entry.alias}`}
                                    flexDirection="column"
                                    paddingX={1}
                                    marginBottom={1}
                                    backgroundColor={
                                        active()
                                            ? props.theme.backgroundElement
                                            : props.theme.background
                                    }
                                >
                                    <box
                                        flexDirection="row"
                                        justifyContent="space-between"
                                    >
                                        <box flexDirection="row" gap={1}>
                                            <text
                                                fg={
                                                    active()
                                                        ? props.theme.accent
                                                        : props.theme.faint
                                                }
                                            >
                                                {active() ? '◆' : '◇'}
                                            </text>
                                            <text fg={props.theme.text}>
                                                <strong>{entry.alias}</strong>
                                            </text>
                                        </box>
                                        <text fg={props.theme.textMuted}>
                                            v{entry.version}
                                        </text>
                                    </box>
                                    <text fg={props.theme.faint} paddingLeft={2}>
                                        {sourceLabel(entry)}
                                    </text>
                                </box>
                            );
                        }}
                    </For>
                </scrollbox>
            </Show>
        </box>
    );
}

function selectionPosition(selected: number, filtered: number, saved: number): string {
    if (filtered === 0) return saved === 0 ? '0 SAVED' : `0 OF ${saved}`;
    const position = Math.min(selected + 1, filtered);
    const direction =
        filtered === 1
            ? ''
            : position === 1
              ? ' · ↓ MORE'
              : position === filtered
                ? ' · ↑ MORE'
                : ' · ↑↓ MORE';
    return `${position} OF ${filtered}${direction}`;
}

function WorkbenchDetails(props: {
    entry: Accessor<CatalogEntry | undefined>;
    detail: Accessor<DetailState>;
    theme: WorkbenchTheme;
    compact: boolean;
}) {
    const ready = createMemo(() => {
        const state = props.detail();
        return state.kind === 'ready' ? state.value : undefined;
    });
    const error = createMemo(() => {
        const state = props.detail();
        return state.kind === 'error' ? state.message : undefined;
    });

    return (
        <box
            flexDirection="column"
            flexGrow={props.compact ? 0 : 1}
            {...(props.compact ? { height: 7 } : {})}
            {...(props.compact
                ? {
                      border: ['top'] as const,
                      borderColor: props.theme.borderSubtle,
                  }
                : {})}
            paddingTop={props.compact ? 1 : 0}
            marginTop={props.compact ? 1 : 0}
        >
            <Show
                when={props.entry()}
                fallback={
                    <box flexGrow={1} justifyContent="center" alignItems="center">
                        <text fg={props.theme.faint}>
                            Save a Workbench to start an expert session.
                        </text>
                    </box>
                }
            >
                {(entry: Accessor<CatalogEntry>) => (
                    <>
                        <box flexDirection="row" justifyContent="space-between">
                            <text fg={props.theme.accent}>
                                <strong>{entry().alias}</strong>
                            </text>
                            <text fg={props.theme.textMuted}>v{entry().version}</text>
                        </box>
                        <Show
                            when={ready()}
                            fallback={
                                <Show
                                    when={error()}
                                    fallback={
                                        <text fg={props.theme.faint}>
                                            Loading package details...
                                        </text>
                                    }
                                >
                                    {(message: Accessor<string>) => (
                                        <box flexDirection="column">
                                            <text fg={props.theme.error}>
                                                Package needs attention
                                            </text>
                                            <text fg={props.theme.faint}>
                                                {message()}
                                            </text>
                                            <text fg={props.theme.textMuted}>
                                                wb upgrade {entry().alias}
                                            </text>
                                        </box>
                                    )}
                                </Show>
                            }
                        >
                            {(value: Accessor<HomeWorkbenchDetails>) => (
                                <>
                                    <text fg={props.theme.text} marginTop={1}>
                                        {value().description ?? entry().name}
                                    </text>
                                    <text fg={props.theme.textMuted} marginTop={1}>
                                        {value().runner} · {value().model}
                                    </text>
                                    <text fg={props.theme.textMuted}>
                                        {value().runtime} runtime
                                    </text>
                                    <Show when={!props.compact}>
                                        <text fg={props.theme.faint} marginTop={1}>
                                            PACKAGE
                                        </text>
                                        <text fg={props.theme.textMuted}>
                                            {sourceLabel(entry())}
                                        </text>
                                        <text fg={props.theme.faint} marginTop={1}>
                                            INCLUDES
                                        </text>
                                        <text fg={props.theme.textMuted}>
                                            {countLabel(value().skills, 'skill')} ·{' '}
                                            {countLabel(value().tools, 'tool')} ·{' '}
                                            {countLabel(value().mcps, 'MCP')}
                                        </text>
                                        <text fg={props.theme.faint} marginTop={1}>
                                            REQUIRES
                                        </text>
                                        <text fg={props.theme.textMuted}>
                                            {inputSummary(value())}
                                        </text>
                                        <box flexGrow={1} />
                                        <text fg={props.theme.faint}>
                                            Preflight checks requirements before launch.
                                        </text>
                                    </Show>
                                </>
                            )}
                        </Show>
                    </>
                )}
            </Show>
        </box>
    );
}

function filterEntries(entries: CatalogEntry[], query: string): CatalogEntry[] {
    const needle = query.trim().toLowerCase();
    if (!needle) return entries;
    return entries.filter((entry) =>
        [entry.alias, entry.name, entry.source, entry.selector].some((value) =>
            value.toLowerCase().includes(needle)
        )
    );
}

function sourceLabel(entry: CatalogEntry): string {
    const github = /^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(
        entry.source
    );
    if (github?.[1]) {
        return `${github[1]}#${entry.selector}`;
    }
    if (!entry.source.startsWith('/')) {
        return `${entry.source}#${entry.selector}`;
    }
    const parts = entry.source.split('/').filter(Boolean);
    return `${parts.slice(-2).join('/')}#${entry.selector}`;
}

function countLabel(count: number, noun: string): string {
    return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function inputSummary(details: HomeWorkbenchDetails): string {
    if (details.environment === 0 && details.workspaces === 0) {
        return 'No declared environment or workspace inputs';
    }
    return [
        countLabel(details.environment, 'environment value'),
        countLabel(details.workspaces, 'workspace'),
    ].join(' · ');
}

function relativeTime(timestamp: string): string {
    const milliseconds = Date.parse(timestamp) - Date.now();
    if (!Number.isFinite(milliseconds)) return 'unknown';
    const seconds = Math.round(milliseconds / 1_000);
    if (Math.abs(seconds) < 60) return 'now';
    const minutes = Math.round(seconds / 60);
    if (Math.abs(minutes) < 60) return `${Math.abs(minutes)}m ago`;
    const hours = Math.round(minutes / 60);
    if (Math.abs(hours) < 24) return `${Math.abs(hours)}h ago`;
    const days = Math.round(hours / 24);
    if (Math.abs(days) < 7) return `${Math.abs(days)}d ago`;
    return new Date(timestamp).toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
    });
}
