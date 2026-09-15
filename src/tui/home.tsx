import type { InputRenderable, KeyEvent } from '@opentui/core';
import { useKeyboard, useTerminalDimensions } from '@opentui/solid';
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from 'solid-js';

import packageMetadata from '../../package.json' with { type: 'json' };
import type { CatalogEntry } from '../catalog/index.js';
import type { RegistrySearchResult } from '../registry/index.js';
import type { ResolvedWorkbenchReference } from '../workbench/index.js';
import { WorkbenchWordmark } from './branding.js';
import { HomeLauncher, type HomeLauncherResult } from './home-launcher.js';
import { useTheme, type WorkbenchTheme } from './theme/index.js';

export interface HomeScreenProps {
    entries: CatalogEntry[];
    resolve: (alias: string) => Promise<ResolvedWorkbenchReference>;
    onOpen: (alias: string, resolved: ResolvedWorkbenchReference) => void;
    onBrowseSessions: () => void;
    searchRegistry?: (query: string) => Promise<RegistrySearchResult[]>;
    onSaveRegistry?: (workbench: RegistrySearchResult) => Promise<CatalogEntry>;
    onCreate?: () => void | Promise<void>;
    onExit: () => void;
    plainBranding?: boolean;
}

export function HomeScreen(props: HomeScreenProps) {
    const dimensions = useTerminalDimensions();
    const { theme } = useTheme();
    const launcher = createMemo(
        () => new HomeLauncher(props.entries, Boolean(props.onCreate))
    );
    const [query, setQuery] = createSignal('');
    const [selected, setSelected] = createSignal(0);
    const [browsing, setBrowsing] = createSignal(false);
    const [registryResults, setRegistryResults] = createSignal<RegistrySearchResult[]>(
        []
    );
    const [registryState, setRegistryState] = createSignal<
        'idle' | 'loading' | 'ready' | 'error'
    >('idle');
    const [registryError, setRegistryError] = createSignal<string>();
    const [status, setStatus] = createSignal<
        { text: string; error: boolean } | undefined
    >();
    const results = createMemo(() => launcher().results(query(), registryResults()));
    const resultLimit = createMemo(() =>
        Math.max(2, Math.min(5, Math.floor((dimensions().height - 17) / 2)))
    );
    const windowStart = createMemo(() =>
        Math.min(
            Math.max(selected() - resultLimit() + 1, 0),
            Math.max(results().length - resultLimit(), 0)
        )
    );
    const visibleResults = createMemo(() =>
        results().slice(windowStart(), windowStart() + resultLimit())
    );
    const current = createMemo(() => results()[selected()]);
    const compact = createMemo(
        () =>
            Boolean(props.plainBranding) ||
            dimensions().width < 68 ||
            dimensions().height < 18
    );
    const launcherWidth = createMemo(() => Math.min(78, dimensions().width - 4));
    let input: InputRenderable | undefined;
    let searchSequence = 0;

    createEffect(() => {
        const value = query().trim();
        const searchRegistry = props.searchRegistry;
        const sequence = ++searchSequence;
        setRegistryResults([]);
        setRegistryError(undefined);
        if (!searchRegistry || value.startsWith('/') || value.length < 2) {
            setRegistryState('idle');
            return;
        }
        setRegistryState('loading');
        const timer = setTimeout(() => {
            void searchRegistry(value)
                .then((found) => {
                    if (sequence !== searchSequence) return;
                    setRegistryResults(found);
                    setRegistryState('ready');
                })
                .catch((error) => {
                    if (sequence !== searchSequence) return;
                    setRegistryError(errorMessage(error));
                    setRegistryState('error');
                });
        }, 180);
        onCleanup(() => clearTimeout(timer));
    });

    createEffect(() => {
        const count = results().length;
        if (count === 0) setSelected(0);
        else if (selected() >= count) setSelected(count - 1);
    });

    const updateQuery = (value: string) => {
        setQuery(value);
        setSelected(0);
        setBrowsing(false);
        setStatus(undefined);
    };
    const setInput = (value: string) => {
        input?.setText(value);
        input?.gotoBufferEnd();
        input?.focus();
        updateQuery(value);
    };
    const move = (direction: number) => {
        const options = results();
        if (options.length === 0) return;
        setSelected((value) => (value + direction + options.length) % options.length);
        setBrowsing(true);
        setStatus(undefined);
    };
    const openWorkbench = async (entry: CatalogEntry) => {
        setStatus({ text: `Opening ${entry.alias}...`, error: false });
        try {
            props.onOpen(entry.alias, await props.resolve(entry.alias));
        } catch (error) {
            setStatus({ text: errorMessage(error), error: true });
        }
    };
    const saveRegistry = async (
        workbench: RegistrySearchResult,
        openAfterSave: boolean
    ) => {
        if (!props.onSaveRegistry) return;
        const reference = `${workbench.reference.publisher}/${workbench.reference.workbench}`;
        setStatus({ text: `Saving ${reference}...`, error: false });
        try {
            const entry = await props.onSaveRegistry(workbench);
            if (openAfterSave) {
                await openWorkbench(entry);
                return;
            }
            setStatus({ text: `Saved ${reference} as ${entry.alias}`, error: false });
            setBrowsing(false);
            input?.focus();
        } catch (error) {
            setStatus({ text: errorMessage(error), error: true });
        }
    };
    const create = async () => {
        if (!props.onCreate) return;
        setStatus({ text: 'Opening the Workbench creator...', error: false });
        try {
            await props.onCreate();
        } catch (error) {
            setStatus({ text: errorMessage(error), error: true });
        }
    };
    const showHelp = () => {
        setStatus({
            text: '/resume [search] · /create · /help · /quit · arrows browse · s save',
            error: false,
        });
    };
    const submit = () => {
        const result = current();
        if (!result) {
            const message = launcher().emptyMessage(
                query(),
                registryState() === 'loading'
            );
            if (message) setStatus({ text: message, error: true });
            return;
        }
        if (result.kind === 'saved') {
            void openWorkbench(result.entry);
            return;
        }
        if (result.kind === 'registry') {
            void saveRegistry(result.workbench, true);
            return;
        }
        if (result.name === 'resume') {
            props.onBrowseSessions();
        } else if (result.name === 'create') {
            void create();
        } else if (result.name === 'help') {
            showHelp();
        } else {
            props.onExit();
        }
    };

    const handleInputKey = (key: KeyEvent) => {
        if (key.name === 'up') {
            key.preventDefault();
            move(-1);
        } else if (key.name === 'down') {
            key.preventDefault();
            move(1);
        } else if (key.name === 'tab' && results().length > 0) {
            key.preventDefault();
            setBrowsing((value) => !value);
        } else if (
            browsing() &&
            (key.name === 's' || key.name === 'space') &&
            current()?.kind === 'registry'
        ) {
            key.preventDefault();
            const result = current();
            if (result?.kind === 'registry') {
                void saveRegistry(result.workbench, false);
            }
        } else if (key.name === 'escape') {
            key.preventDefault();
            if (browsing()) setBrowsing(false);
            else if (query()) setInput('');
            else props.onExit();
        }
    };

    useKeyboard((key) => {
        if (key.ctrl && key.name === 'c') {
            key.preventDefault();
            props.onExit();
        } else if (key.ctrl && key.name === 'r') {
            key.preventDefault();
            props.onBrowseSessions();
        } else if (key.ctrl && key.name === 'n' && props.onCreate) {
            key.preventDefault();
            void create();
        }
    });

    return (
        <box flexDirection="column" flexGrow={1} alignItems="center" paddingX={2}>
            <box flexGrow={1} minHeight={0} />
            <box height={compact() ? 1 : 4} flexShrink={0}>
                <WorkbenchWordmark compact={compact()} />
            </box>
            <box height={compact() ? 1 : 2} minHeight={0} flexShrink={1} />
            <box width="100%" maxWidth={launcherWidth()} flexDirection="column">
                <box
                    border={['left']}
                    borderColor={status()?.error ? theme.error : theme.primary}
                    backgroundColor={theme.backgroundElement}
                    paddingX={2}
                    paddingY={1}
                >
                    <input
                        id="home-launcher"
                        ref={(value) => {
                            input = value;
                            value.focus();
                        }}
                        value={query()}
                        onInput={updateQuery}
                        onSubmit={submit}
                        onKeyDown={handleInputKey}
                        placeholder="Search saved and published Workbenches, or type /"
                        placeholderColor={theme.textMuted}
                        textColor={theme.text}
                        focusedTextColor={theme.text}
                        cursorColor={theme.text}
                        backgroundColor={theme.backgroundElement}
                        focusedBackgroundColor={theme.backgroundElement}
                    />
                </box>
                <box flexDirection="row" justifyContent="space-between" paddingX={1}>
                    <text fg={theme.faint}>
                        {browsing()
                            ? '↑↓ choose · s/space save · esc search'
                            : 'type to search · ↑↓ browse · / commands'}
                    </text>
                    <text fg={theme.faint}>
                        {current()?.kind === 'registry'
                            ? 'enter save + open'
                            : 'enter open'}
                    </text>
                </box>
                <Show when={visibleResults().length > 0}>
                    <LauncherResults
                        results={visibleResults()}
                        selected={selected() - windowStart()}
                        position={selected() + 1}
                        total={results().length}
                        theme={theme}
                    />
                </Show>
                <Show when={registryState() === 'loading'}>
                    <text fg={theme.faint} paddingX={1} marginTop={1}>
                        Searching the registry...
                    </text>
                </Show>
                <Show when={registryState() === 'error'}>
                    <text fg={theme.warning} paddingX={1} marginTop={1}>
                        Registry search unavailable: {registryError()}
                    </text>
                </Show>
                <Show when={status()}>
                    <text
                        fg={status()?.error ? theme.error : theme.textMuted}
                        paddingX={1}
                        marginTop={1}
                        wrapMode="word"
                    >
                        {status()?.text}
                    </text>
                </Show>
            </box>
            <box flexGrow={1} minHeight={0} />
            <box
                width="100%"
                flexDirection="row"
                justifyContent="space-between"
                paddingBottom={1}
            >
                <text fg={theme.faint}>
                    Tip Search by publisher, name, or expertise
                </text>
                <text fg={theme.faint}>v{packageMetadata.version}</text>
            </box>
        </box>
    );
}

function LauncherResults(props: {
    results: HomeLauncherResult[];
    selected: number;
    position: number;
    total: number;
    theme: WorkbenchTheme;
}) {
    return (
        <box
            flexDirection="column"
            marginTop={1}
            backgroundColor={props.theme.backgroundPanel}
        >
            <Show when={props.total > props.results.length}>
                <box paddingX={2} flexDirection="row" justifyContent="flex-end">
                    <text fg={props.theme.faint}>
                        {props.position} of {props.total}
                    </text>
                </box>
            </Show>
            <For each={props.results}>
                {(result, index) => {
                    const active = () => index() === props.selected;
                    return (
                        <box
                            flexDirection="column"
                            paddingX={2}
                            backgroundColor={
                                active()
                                    ? props.theme.backgroundElement
                                    : props.theme.backgroundPanel
                            }
                        >
                            <box flexDirection="row" justifyContent="space-between">
                                <text
                                    fg={
                                        active()
                                            ? props.theme.primary
                                            : props.theme.text
                                    }
                                >
                                    <strong>{resultTitle(result)}</strong>
                                </text>
                                <text fg={props.theme.faint}>
                                    {resultAside(result)}
                                </text>
                            </box>
                            <text fg={props.theme.textMuted} truncate={true}>
                                {resultDescription(result)}
                            </text>
                        </box>
                    );
                }}
            </For>
        </box>
    );
}

function resultTitle(result: HomeLauncherResult): string {
    if (result.kind === 'saved') return result.entry.alias;
    if (result.kind === 'registry') return result.workbench.name;
    return result.title;
}

function resultAside(result: HomeLauncherResult): string {
    if (result.kind === 'saved') return `SAVED · v${result.entry.version}`;
    if (result.kind === 'registry') {
        const runs = result.workbench.runs;
        return runs > 0 ? `REGISTRY · ${compactCount(runs)} runs` : 'REGISTRY';
    }
    return '';
}

function resultDescription(result: HomeLauncherResult): string {
    if (result.kind === 'saved') return sourceLabel(result.entry);
    if (result.kind === 'registry') {
        const publisher = result.workbench.verifiedPublisher
            ? `✓ ${result.workbench.publisherName}`
            : result.workbench.publisherName;
        return `${publisher}/${result.workbench.reference.workbench} · v${result.workbench.version} · ${result.workbench.summary ?? `${result.workbench.runner} on ${result.workbench.runtime}`}`;
    }
    return result.description;
}

function compactCount(value: number): string {
    return new Intl.NumberFormat(undefined, {
        notation: 'compact',
        maximumFractionDigits: 1,
    }).format(value);
}

function sourceLabel(entry: CatalogEntry): string {
    if (entry.registry) {
        return `${entry.registry.publisher}/${entry.registry.workbench}#${entry.selector}`;
    }
    const github = /^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(
        entry.source
    );
    if (github?.[1]) return `${github[1]}#${entry.selector}`;
    if (!entry.source.startsWith('/')) return `${entry.source}#${entry.selector}`;
    const parts = entry.source.split('/').filter(Boolean);
    return `${parts.slice(-2).join('/')}#${entry.selector}`;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
