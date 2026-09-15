import { createSignal, onCleanup, onMount } from 'solid-js';

import { useTheme } from './theme/index.js';

const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export function ActivityIndicator(props: { label: string }) {
    const { theme } = useTheme();
    const [frame, setFrame] = createSignal(0);

    onMount(() => {
        const timer = setInterval(
            () => setFrame((current) => (current + 1) % frames.length),
            80
        );
        onCleanup(() => clearInterval(timer));
    });

    return (
        <box flexDirection="row" gap={1}>
            <text fg={theme.mint}>{frames[frame()]}</text>
            <text fg={theme.muted}>{props.label}</text>
        </box>
    );
}

export function usageLabel(
    tokens: number | undefined,
    cost: number | undefined
): string {
    const details: string[] = [];
    if (tokens !== undefined) details.push(`${tokens.toLocaleString()} tokens`);
    if (cost !== undefined) details.push(`$${cost.toFixed(4)}`);
    return details.length ? `${details.join(' · ')} · ` : '';
}
