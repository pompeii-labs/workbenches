import { Match, Show, Switch } from 'solid-js';

import { renderMarkdownPreview, sanitizeMarkdown } from '../rendering/index.js';
import type { TranscriptItem } from './model.js';
import { markdownStyle, theme } from './theme.js';

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
                                    ? normalizeTuiMarkdown(props.item.text)
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
