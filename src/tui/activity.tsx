import { createSignal, onCleanup, onMount, Show } from 'solid-js';

import { useTheme } from './theme/index.js';

const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export function ActivityIndicator(props: { label: string; elapsed?: boolean }) {
    const { theme } = useTheme();
    const [frame, setFrame] = createSignal(0);
    const [seconds, setSeconds] = createSignal(0);

    onMount(() => {
        const startedAt = Date.now();
        const timer = setInterval(() => {
            setFrame((current) => (current + 1) % frames.length);
            if (props.elapsed) setSeconds(Math.floor((Date.now() - startedAt) / 1_000));
        }, 80);
        onCleanup(() => clearInterval(timer));
    });

    return (
        <box flexDirection="row" gap={1}>
            <text fg={theme.mint}>{frames[frame()]}</text>
            <text fg={theme.muted}>{props.label}</text>
            <Show when={props.elapsed}>
                <text fg={theme.faint}>{seconds()}s</text>
            </Show>
        </box>
    );
}

export function startupLabel(
    runtime: string,
    runner: string,
    status: string,
    resuming = false
): string | undefined {
    if (status !== 'Connecting' && status !== 'Starting') return;
    const harness =
        runner === 'opencode' ? 'OpenCode' : runner === 'pi' ? 'Pi' : runner;
    if (status === 'Starting') return `Starting ${harness}...`;
    if (resuming) {
        return `Connecting to ${runtime === 'e2b' ? 'E2B' : runtime === 'docker' ? 'Docker' : harness} session...`;
    }
    if (runtime === 'e2b') return 'Starting E2B sandbox...';
    if (runtime === 'docker') return 'Starting Docker container...';
    return `Starting ${harness}...`;
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
