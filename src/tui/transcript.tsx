import { isAbsolute, relative } from 'node:path';

import { type Accessor, For, Match, Show, Switch } from 'solid-js';

import { sanitizeMarkdown } from '../rendering/index.js';
import { ActivityIndicator } from './activity.js';
import type { TranscriptDisplayItem } from './model.js';
import { OutcomeCard } from './outcome-card.js';
import { useTheme } from './theme/index.js';

export function Transcript(props: {
    item: TranscriptDisplayItem;
    streaming: boolean;
    assistantLabel: string;
    workspace?: string;
    home?: string;
}) {
    const { syntax, theme } = useTheme();
    return (
        <Switch>
            <Match when={props.item.kind === 'user'}>
                <box border={['left']} borderColor={theme.accent} marginTop={1}>
                    <box
                        flexDirection="column"
                        backgroundColor={theme.backgroundPanel}
                        paddingLeft={2}
                        paddingRight={1}
                        paddingTop={1}
                        paddingBottom={1}
                    >
                        <text fg={theme.text} wrapMode="word">
                            {props.item.kind === 'user' ? props.item.text : ''}
                        </text>
                        <Show
                            when={
                                props.item.kind === 'user' && props.item.images?.length
                                    ? props.item.images
                                    : undefined
                            }
                        >
                            {(images: Accessor<string[]>) => (
                                <text fg={theme.textMuted} marginTop={1}>
                                    {images()
                                        .map((name) => `[image ${name}]`)
                                        .join(' ')}
                                </text>
                            )}
                        </Show>
                    </box>
                </box>
            </Match>
            <Match when={props.item.kind === 'assistant'}>
                <box
                    id={`transcript-${props.item.id}`}
                    flexDirection="column"
                    marginTop={1}
                >
                    <text fg={theme.accent}>{props.assistantLabel}</text>
                    <markdown
                        content={
                            props.item.kind === 'assistant'
                                ? normalizeTuiMarkdown(props.item.text)
                                : ''
                        }
                        syntaxStyle={syntax()}
                        fg={theme.text}
                        conceal={true}
                        concealCode={true}
                        streaming={props.streaming}
                        internalBlockMode="top-level"
                        tableOptions={{
                            style: 'columns',
                            widthMode: 'full',
                            wrapMode: 'word',
                            cellPaddingX: 1,
                        }}
                        width="100%"
                    />
                </box>
            </Match>
            <Match when={props.item.kind === 'activity'}>
                {props.item.kind === 'activity' ? (
                    <ToolActivityList
                        item={props.item}
                        {...(props.workspace ? { workspace: props.workspace } : {})}
                    />
                ) : null}
            </Match>
            <Match when={props.item.kind === 'notice'}>
                <box marginTop={1}>
                    <text
                        fg={
                            props.item.kind === 'notice' && props.item.tone === 'error'
                                ? theme.red
                                : theme.muted
                        }
                    >
                        {props.item.kind === 'notice' ? props.item.text : ''}
                    </text>
                </box>
            </Match>
            <Match when={props.item.kind === 'outcome'}>
                {props.item.kind === 'outcome' ? (
                    <OutcomeCard
                        item={props.item}
                        {...(props.home ? { home: props.home } : {})}
                    />
                ) : null}
            </Match>
        </Switch>
    );
}

function ToolActivityList(props: {
    item: Extract<TranscriptDisplayItem, { kind: 'activity' }>;
    workspace?: string;
}) {
    return (
        <box flexDirection="column" marginLeft={1} marginTop={1}>
            <For each={props.item.tools}>
                {(tool) => (
                    <ToolActivity
                        tool={tool}
                        {...(props.workspace ? { workspace: props.workspace } : {})}
                    />
                )}
            </For>
        </box>
    );
}

function ToolActivity(props: {
    tool: Extract<TranscriptDisplayItem, { kind: 'activity' }>['tools'][number];
    workspace?: string;
}) {
    const { theme } = useTheme();
    const label = () => `${toolIcon(props.tool.name)} ${props.tool.title}`;
    const detail = () =>
        [
            displayTarget(props.tool.target, props.workspace),
            props.tool.description,
            durationLabel(props.tool.durationMs),
        ]
            .filter(Boolean)
            .join(' · ');

    return (
        <box flexDirection="column">
            <Show
                when={props.tool.status === 'running'}
                fallback={
                    <box flexDirection="row">
                        <text
                            width={2}
                            flexShrink={0}
                            fg={props.tool.status === 'failed' ? theme.red : theme.mint}
                        >
                            {props.tool.status === 'failed' ? '✗' : '✓'}
                        </text>
                        <text
                            fg={
                                props.tool.status === 'failed' ? theme.red : theme.muted
                            }
                            wrapMode="word"
                        >
                            {label()}
                            <Show when={detail()}>
                                {(value: Accessor<string>) => (
                                    <span style={{ fg: theme.faint }}>
                                        {' '}
                                        · {value()}
                                    </span>
                                )}
                            </Show>
                        </text>
                    </box>
                }
            >
                <ActivityIndicator
                    label={`${label()}${detail() ? ` · ${detail()}` : ''}`}
                />
            </Show>
            <Show when={props.tool.error}>
                {(error: Accessor<string>) => (
                    <text fg={theme.red} marginLeft={2} wrapMode="word">
                        {error()}
                    </text>
                )}
            </Show>
        </box>
    );
}

function toolIcon(name: string): string {
    const normalized = name.toLowerCase();
    if (['bash', 'shell', 'shell_command'].includes(normalized)) return '$';
    if (['glob', 'grep'].includes(normalized)) return '✱';
    if (['write', 'edit'].includes(normalized)) return '←';
    if (['apply_patch', 'patch'].includes(normalized)) return '%';
    if (['webfetch', 'web_fetch'].includes(normalized)) return '%';
    if (['websearch', 'web_search'].includes(normalized)) return '◈';
    if (['todowrite', 'todo_write'].includes(normalized)) return '#';
    if (['task', 'agent'].includes(normalized)) return '•';
    if (['read', 'list', 'ls', 'skill'].includes(normalized)) return '→';
    return '⚙';
}

function displayTarget(
    target: string | undefined,
    workspace: string | undefined
): string | undefined {
    if (!target || !workspace || !isAbsolute(target)) return target;
    const local = relative(workspace, target);
    return local && !local.startsWith('..') && !isAbsolute(local) ? local : target;
}

function durationLabel(milliseconds: number | undefined): string | undefined {
    if (milliseconds === undefined || milliseconds < 0) return undefined;
    if (milliseconds < 1000) return `${Math.round(milliseconds)}ms`;
    if (milliseconds < 60_000) {
        return `${(milliseconds / 1000).toFixed(milliseconds < 10_000 ? 1 : 0)}s`;
    }
    const minutes = Math.floor(milliseconds / 60_000);
    const seconds = Math.round((milliseconds % 60_000) / 1000);
    return `${minutes}m ${seconds}s`;
}

function normalizeTuiMarkdown(value: string): string {
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
