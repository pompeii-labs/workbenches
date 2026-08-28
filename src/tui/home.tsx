import { useKeyboard } from '@opentui/solid';
import { type Accessor, createMemo, createSignal, For, Show } from 'solid-js';

import type { CatalogEntry } from '../catalog/index.js';
import type { ResolvedWorkbenchReference } from '../workbench/index.js';
import { theme } from './theme.js';

export interface HomeScreenProps {
    entries: CatalogEntry[];
    resolve: (alias: string) => Promise<ResolvedWorkbenchReference>;
    onOpen: (alias: string, resolved: ResolvedWorkbenchReference) => void;
    onExit: () => void;
}

export function HomeScreen(props: HomeScreenProps) {
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
                            ref={(value) => value.focus()}
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
