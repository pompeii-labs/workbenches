import { useTerminalDimensions } from '@opentui/solid';
import { createMemo, Show } from 'solid-js';

import { modelLabel } from '../models/index.js';
import type { WorkbenchManifest } from '../types.js';
import { useTheme } from './theme/index.js';

export function ChatHeader(props: {
    alias: string;
    sessionName: string | undefined;
    manifest: WorkbenchManifest;
}) {
    const dimensions = useTerminalDimensions();
    const { theme } = useTheme();
    const details = createMemo(
        () =>
            `${props.manifest.runner} · ${modelLabel(props.manifest.model)} · ${props.manifest.runtime}`
    );
    const showDetails = createMemo(() => dimensions().width >= 100);
    const title = createMemo(() => {
        const identity = props.sessionName ?? props.alias;
        const value =
            identity === props.manifest.name
                ? identity
                : `${identity} · ${props.manifest.name}`;
        const reserved = showDetails() ? [...details()].length + 12 : 8;
        return truncate(value, Math.max(1, dimensions().width - reserved));
    });

    return (
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
                    <strong>{title()}</strong>
                </text>
            </box>
            <Show when={showDetails()}>
                <text fg={theme.muted}>{details()}</text>
            </Show>
        </box>
    );
}

function truncate(value: string, maximum: number): string {
    if (Bun.stringWidth(value) <= maximum) return value;
    if (maximum === 1) return '…';

    let result = '';
    let width = 0;
    for (const { segment } of new Intl.Segmenter(undefined, {
        granularity: 'grapheme',
    }).segment(value)) {
        const nextWidth = Bun.stringWidth(segment);
        if (width + nextWidth > maximum - 1) break;
        result += segment;
        width += nextWidth;
    }
    return `${result}…`;
}
