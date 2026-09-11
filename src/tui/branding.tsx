import { RGBA, TextAttributes } from '@opentui/core';
import { For, type JSX, Show } from 'solid-js';

import { workbenchWordmark } from './brand.js';
import { useTheme } from './theme/index.js';

export function WorkbenchWordmark(props: { compact?: boolean }) {
    const { theme } = useTheme();
    return (
        <Show
            when={!props.compact}
            fallback={
                <text fg={theme.accent}>
                    <strong>◆ workbench</strong>
                </text>
            }
        >
            <box flexDirection="column">
                <For each={workbenchWordmark.work}>
                    {(line, index) => (
                        <box flexDirection="row" gap={1}>
                            <box flexDirection="row">
                                {renderLine(
                                    line,
                                    RGBA.fromHex(theme.textMuted),
                                    RGBA.fromHex(theme.background),
                                    false
                                )}
                            </box>
                            <box flexDirection="row">
                                {renderLine(
                                    workbenchWordmark.bench[index()] ?? '',
                                    RGBA.fromHex(theme.accent),
                                    RGBA.fromHex(theme.background),
                                    true
                                )}
                            </box>
                        </box>
                    )}
                </For>
            </box>
        </Show>
    );
}

function renderLine(
    line: string,
    foreground: RGBA,
    background: RGBA,
    bold: boolean
): JSX.Element[] {
    const shadow = tint(background, foreground, 0.25);
    const attributes = bold ? TextAttributes.BOLD : 0;
    return Array.from(line).map((character) => {
        if (character === '_') {
            return (
                <text
                    fg={foreground}
                    bg={shadow}
                    attributes={attributes}
                    selectable={false}
                >
                    {' '}
                </text>
            );
        }
        if (character === '^') {
            return (
                <text
                    fg={foreground}
                    bg={shadow}
                    attributes={attributes}
                    selectable={false}
                >
                    ▀
                </text>
            );
        }
        if (character === '~') {
            return (
                <text fg={shadow} attributes={attributes} selectable={false}>
                    ▀
                </text>
            );
        }
        if (character === ',') {
            return (
                <text fg={shadow} attributes={attributes} selectable={false}>
                    ▄
                </text>
            );
        }
        return (
            <text fg={foreground} attributes={attributes} selectable={false}>
                {character}
            </text>
        );
    });
}

function tint(base: RGBA, overlay: RGBA, alpha: number): RGBA {
    return RGBA.fromInts(
        Math.round((base.r + (overlay.r - base.r) * alpha) * 255),
        Math.round((base.g + (overlay.g - base.g) * alpha) * 255),
        Math.round((base.b + (overlay.b - base.b) * alpha) * 255)
    );
}
