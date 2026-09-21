import type { ScrollBoxRenderable } from '@opentui/core';
import { useKeyboard, useTerminalDimensions } from '@opentui/solid';
import {
    type Accessor,
    createEffect,
    createMemo,
    createSignal,
    For,
    onCleanup,
    onMount,
    Show,
} from 'solid-js';
import { sanitizeMarkdown } from '../../rendering/index.js';
import type { RepositoryCheckReport, RepositoryLog } from '../../repositories/index.js';
import { useDialog } from '../dialog/index.js';
import { showOutcomeDialog } from '../dialog/outcome.js';
import { useTheme } from '../theme/index.js';
import type { RepositoryController } from './controller.js';

export function RepositoryPanel(props: {
    controller: RepositoryController;
    home: string;
}) {
    const { theme } = useTheme();
    const dimensions = useTerminalDimensions();
    const dialog = useDialog();
    const state = props.controller.state;
    const [selected, setSelected] = createSignal(0);
    const [log, setLog] = createSignal<RepositoryLog>();
    const [error, setError] = createSignal('');
    const [loading, setLoading] = createSignal(false);
    const jobs = createMemo(() => state().checks?.jobs ?? []);
    createEffect(() => {
        const count = jobs().length;
        setSelected((value) => Math.min(value, Math.max(0, count - 1)));
    });
    let scroll: ScrollBoxRenderable | undefined;
    let disposed = false;
    const readLogs = async () => {
        const job = jobs()[selected()];
        if (!job || loading()) return;
        setLoading(true);
        setError('');
        try {
            const result = await props.controller.logs(job.id);
            if (!disposed) {
                setLog(result);
                scroll?.scrollTo(0);
            }
        } catch (cause) {
            if (!disposed)
                setError(
                    cause instanceof Error ? cause.message : 'CI logs unavailable'
                );
        } finally {
            if (!disposed) setLoading(false);
        }
    };
    onMount(() => void props.controller.refresh());
    onCleanup(() => {
        disposed = true;
        props.controller.watch(false);
    });
    useKeyboard((key) => {
        if (key.defaultPrevented || key.ctrl || key.meta) return;
        if (log()) {
            if (key.name === 'b') {
                key.preventDefault();
                setLog(undefined);
                scroll?.scrollTo(0);
            } else if (['up', 'down', 'pageup', 'pagedown'].includes(key.name)) {
                key.preventDefault();
                scroll?.scrollBy(
                    (key.name.endsWith('down') ? 1 : -1) *
                        (key.name.startsWith('page') ? 8 : 1)
                );
            }
            return;
        }
        if (key.name === 'r') {
            key.preventDefault();
            void props.controller.refresh();
        } else if (key.name === 'w') {
            key.preventDefault();
            props.controller.watch(!state().watching);
        } else if (key.name === 'o') {
            key.preventDefault();
            void props.controller.open();
        } else if (key.name === 'v') {
            key.preventDefault();
            const job = jobs()[selected()];
            if (job) void props.controller.open(job.url);
        } else if (key.name === 'd') {
            key.preventDefault();
            void showOutcomeDialog(
                props.home,
                state().status?.receipt?.outcome_id ?? state().status?.run.outcome_id,
                dialog,
                setError,
                true
            );
        } else if (key.name === 'return') {
            key.preventDefault();
            void readLogs();
        } else if (key.name === 'up' || key.name === 'down') {
            key.preventDefault();
            const count = jobs().length;
            if (count)
                setSelected(
                    (value) => (value + (key.name === 'down' ? 1 : count - 1)) % count
                );
            scroll?.scrollBy(key.name === 'down' ? 1 : -1);
        } else if (key.name === 'pagedown' || key.name === 'pageup') {
            key.preventDefault();
            scroll?.scrollBy(key.name === 'pagedown' ? 8 : -8);
        }
    });
    const receipt = () => state().status?.receipt;
    const pull = () => state().checks?.pull_request;
    return (
        <box flexDirection="column" paddingX={2} paddingY={1}>
            <text fg={theme.text}>
                <strong>GitHub · {props.controller.target}</strong>
            </text>
            <text fg={theme.textMuted} truncate={true}>
                base {state().status?.binding.base_branch ?? 'default'} ·{' '}
                {state().status?.binding.delivery === 'pr'
                    ? 'GitHub token supplied to agent runtime'
                    : 'no GitHub token injected'}
            </text>
            <scrollbox
                ref={(value) => {
                    scroll = value;
                }}
                maxHeight={Math.max(4, Math.floor(dimensions().height * 0.6) - 5)}
            >
                <Show
                    when={log()}
                    fallback={
                        <>
                            <Show
                                when={receipt()?.pull_request}
                                fallback={
                                    <text fg={theme.textMuted} marginTop={1}>
                                        {state().status?.binding.delivery === 'pr'
                                            ? 'No confirmed PR link yet. Ask the agent to create one when the task calls for it.'
                                            : 'Inspect saved changes with d or /outcome.'}
                                    </text>
                                }
                            >
                                {(pr: Accessor<{ url: string; number: number }>) => (
                                    <text fg={theme.accent} marginTop={1}>
                                        <a href={pr().url}>PR #{pr().number}</a>
                                        {pull()
                                            ? ` · ${pull()?.merged ? 'merged' : pull()?.state} · ${pull()?.draft ? 'draft' : 'ready'}`
                                            : ' · verified on GitHub'}
                                    </text>
                                )}
                            </Show>
                            <Show
                                when={state().checks}
                                fallback={
                                    <text fg={theme.textMuted}>
                                        CI has not been checked here.
                                    </text>
                                }
                            >
                                {(checks: Accessor<RepositoryCheckReport>) => (
                                    <>
                                        <text
                                            fg={
                                                checks().state === 'failed'
                                                    ? theme.error
                                                    : theme.text
                                            }
                                            marginTop={1}
                                        >
                                            CI {checks().state} · commit{' '}
                                            {checks().pull_request.head.slice(0, 8)}
                                        </text>
                                        <text fg={theme.faint}>
                                            Checked{' '}
                                            {state().checkedAt
                                                ? new Date(
                                                      state().checkedAt as string
                                                  ).toLocaleTimeString()
                                                : 'not yet'}{' '}
                                            ·{' '}
                                            {state().watching
                                                ? 'watching every 30s'
                                                : 'manual refresh'}
                                        </text>
                                        <Show when={checks().warning}>
                                            <text fg={theme.warning} wrapMode="word">
                                                {checks().warning}
                                            </text>
                                        </Show>
                                        <For each={checks().checks}>
                                            {(check) => (
                                                <text
                                                    fg={theme.textMuted}
                                                    wrapMode="word"
                                                >
                                                    {sanitizeMarkdown(check.name)} ·{' '}
                                                    {check.conclusion ?? check.status}
                                                </text>
                                            )}
                                        </For>
                                        <For each={checks().statuses}>
                                            {(status) => (
                                                <text
                                                    fg={theme.textMuted}
                                                    wrapMode="word"
                                                >
                                                    {sanitizeMarkdown(status.context)} ·{' '}
                                                    {status.state}
                                                </text>
                                            )}
                                        </For>
                                        <For each={checks().workflows}>
                                            {(run) => (
                                                <text
                                                    fg={theme.textMuted}
                                                    wrapMode="word"
                                                >
                                                    Workflow{' '}
                                                    {sanitizeMarkdown(run.name)} ·{' '}
                                                    {run.conclusion ?? run.status}
                                                </text>
                                            )}
                                        </For>
                                        <Show when={jobs().length}>
                                            <text fg={theme.text} marginTop={1}>
                                                Jobs (enter reads selected logs)
                                            </text>
                                        </Show>
                                        <For each={jobs()}>
                                            {(job, index) => (
                                                <box
                                                    backgroundColor={
                                                        selected() === index()
                                                            ? theme.backgroundElement
                                                            : theme.backgroundPanel
                                                    }
                                                >
                                                    <text
                                                        fg={
                                                            selected() === index()
                                                                ? theme.primary
                                                                : theme.textMuted
                                                        }
                                                        wrapMode="word"
                                                    >
                                                        {selected() === index()
                                                            ? '›'
                                                            : ' '}{' '}
                                                        {sanitizeMarkdown(job.name)} ·{' '}
                                                        {job.conclusion ?? job.status}
                                                    </text>
                                                </box>
                                            )}
                                        </For>
                                    </>
                                )}
                            </Show>
                        </>
                    }
                >
                    {(logs: Accessor<RepositoryLog>) => (
                        <>
                            <text fg={theme.text} marginTop={1}>
                                <strong>{sanitizeMarkdown(logs().name)}</strong> · job{' '}
                                {logs().job_id}
                            </text>
                            <text fg={theme.faint}>
                                Commit {logs().pull_request.head.slice(0, 8)} ·{' '}
                                {logs().truncated
                                    ? 'truncated at 128 KiB'
                                    : 'downloaded snapshot'}
                            </text>
                            <text fg={theme.textMuted} wrapMode="word">
                                {sanitizeMarkdown(logs().text)}
                            </text>
                        </>
                    )}
                </Show>
                <Show when={state().error || error()}>
                    <text fg={theme.error} wrapMode="word">
                        {sanitizeMarkdown(error() || state().error || '')}
                    </text>
                </Show>
            </scrollbox>
            <text fg={theme.faint} marginTop={1}>
                {state().busy || loading()
                    ? 'Loading GitHub...'
                    : log()
                      ? '↑↓ scroll · b back · esc close'
                      : 'r refresh · w watch · o PR · v job · ↑↓ jobs · enter logs'}
            </text>
            <Show when={!log()}>
                <text fg={theme.faint}>d saved diff · esc close</text>
            </Show>
        </box>
    );
}
