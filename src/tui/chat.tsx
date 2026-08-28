import type { InputRenderable } from '@opentui/core';
import { useKeyboard } from '@opentui/solid';
import { type Accessor, createSignal, For, onCleanup, onMount, Show } from 'solid-js';

import { modelLabel } from '../models/index.js';
import type {
    RunnerPermissionDecision,
    RunnerPermissionRequest,
} from '../runners/session.js';
import type { InteractiveRunSession, WorkbenchEvent } from '../runs/index.js';
import type { ResolvedWorkbenchReference } from '../workbench/index.js';
import {
    addUserMessage,
    emptyTranscript,
    reduceTranscript,
    TranscriptEventBuffer,
} from './model.js';
import { theme } from './theme.js';
import { Transcript } from './transcript.js';

export interface ChatScreenProps {
    alias: string;
    resolved: ResolvedWorkbenchReference;
    start: (options: {
        resolved: ResolvedWorkbenchReference;
        reference: string;
        onEvent: (event: WorkbenchEvent) => void;
        onPermission: (
            request: RunnerPermissionRequest
        ) => Promise<RunnerPermissionDecision>;
    }) => Promise<InteractiveRunSession>;
    onBack: () => void;
    onExit: () => void;
    homeAvailable: boolean;
}

export function ChatScreen(props: ChatScreenProps) {
    const [state, setState] = createSignal(emptyTranscript());
    const [error, setError] = createSignal('');
    const [permission, setPermission] = createSignal<{
        request: RunnerPermissionRequest;
        resolve: (decision: RunnerPermissionDecision) => void;
    }>();
    let session: InteractiveRunSession | undefined;
    let composer!: InputRenderable;
    let leaving = false;
    const events = new TranscriptEventBuffer((event) =>
        setState((current) => reduceTranscript(current, event))
    );

    const decidePermission = (decision: RunnerPermissionDecision) => {
        const pending = permission();
        if (!pending) return;
        setPermission(undefined);
        setState((current) => ({ ...current, status: 'Working' }));
        pending.resolve(decision);
    };
    const close = async (back: boolean) => {
        if (leaving) return;
        leaving = true;
        decidePermission('reject');
        await session?.close().catch(() => {});
        await props.resolved.cleanup();
        if (back) props.onBack();
        else props.onExit();
    };
    const submit = async (value: string) => {
        const task = value.trim();
        if (!task || !session || state().busy || permission()) return;
        composer.value = '';
        setState((current) => addUserMessage(current, task));
        try {
            await session.send(task);
        } catch (cause) {
            const message = cause instanceof Error ? cause.message : String(cause);
            setError(message);
            setState((current) => ({ ...current, busy: false, status: 'Failed' }));
        }
    };

    onMount(async () => {
        try {
            session = await props.start({
                resolved: props.resolved,
                reference: props.alias,
                onEvent: (event) => events.push(event),
                onPermission: (request) =>
                    new Promise((resolve) => {
                        setPermission({ request, resolve });
                    }),
            });
            composer?.focus();
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
            setState((current) => ({ ...current, status: 'Failed' }));
        }
    });
    onCleanup(() => {
        events.dispose();
        if (!leaving) {
            leaving = true;
            decidePermission('reject');
            void session?.close();
            void props.resolved.cleanup();
        }
    });
    useKeyboard((key) => {
        const pending = permission();
        if (pending) {
            if (key.ctrl && key.name === 'c') {
                key.preventDefault();
                decidePermission('reject');
                void session?.cancelTurn();
                return;
            }
            if (key.name === 'y') {
                key.preventDefault();
                decidePermission('allow_once');
                return;
            }
            if (key.name === 'a' && pending.request.allowAlways) {
                key.preventDefault();
                decidePermission('allow_always');
                return;
            }
            if (key.name === 'n' || key.name === 'escape') {
                key.preventDefault();
                decidePermission('reject');
                return;
            }
        }
        if (key.ctrl && key.name === 'c') {
            key.preventDefault();
            if (state().busy) void session?.cancelTurn();
            else void close(false);
        } else if (key.name === 'escape' && props.homeAvailable && !state().busy) {
            key.preventDefault();
            void close(true);
        }
    });

    const manifest = props.resolved.workbench.manifest;
    return (
        <box flexDirection="column" flexGrow={1} paddingX={3} paddingY={1}>
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
                        <strong>{props.alias}</strong>
                    </text>
                    <text fg={theme.muted}>· {manifest.name}</text>
                </box>
                <text fg={theme.muted}>
                    {manifest.runner} · {modelLabel(manifest.model)} ·{' '}
                    {manifest.runtime}
                </text>
            </box>

            <scrollbox
                flexGrow={1}
                stickyScroll={true}
                stickyStart="bottom"
                paddingX={1}
                paddingY={1}
            >
                <Show
                    when={state().items.length === 0 && !error()}
                    fallback={<box height={0} />}
                >
                    <box flexDirection="column" paddingTop={2}>
                        <text fg={theme.muted}>Ready when you are.</text>
                        <text fg={theme.faint}>
                            This session keeps its context across every turn.
                        </text>
                    </box>
                </Show>
                <For each={state().items} fallback={<box height={0} />}>
                    {(item, index) => (
                        <Transcript
                            item={item}
                            streaming={
                                item.kind === 'assistant' &&
                                state().busy &&
                                index() === state().items.length - 1
                            }
                        />
                    )}
                </For>
                <Show when={error().length > 0} fallback={<box height={0} />}>
                    <box
                        border={['left']}
                        borderColor={theme.red}
                        paddingLeft={1}
                        marginY={1}
                    >
                        <text fg={theme.red}>{error()}</text>
                    </box>
                </Show>
            </scrollbox>

            <Show
                when={permission()}
                fallback={
                    <box
                        border={true}
                        borderStyle="rounded"
                        borderColor={state().busy ? theme.faint : theme.accent}
                        backgroundColor={theme.panelRaised}
                        paddingX={1}
                        flexDirection="row"
                    >
                        <text fg={state().busy ? theme.faint : theme.accent}>› </text>
                        <input
                            ref={(value) => {
                                composer = value;
                                value.focus();
                            }}
                            placeholder={
                                state().busy ? 'Workbench is working…' : 'Ask anything'
                            }
                            placeholderColor={theme.faint}
                            textColor={theme.text}
                            focusedTextColor={theme.text}
                            backgroundColor={theme.panelRaised}
                            focusedBackgroundColor={theme.panelRaised}
                            flexGrow={1}
                            on:enter={(value: string) => void submit(value)}
                        />
                    </box>
                }
            >
                {(
                    pending: Accessor<{
                        request: RunnerPermissionRequest;
                        resolve: (decision: RunnerPermissionDecision) => void;
                    }>
                ) => (
                    <box
                        height={5}
                        border={true}
                        borderStyle="rounded"
                        borderColor={theme.yellow}
                        backgroundColor={theme.panelRaised}
                        paddingX={1}
                        flexDirection="column"
                    >
                        <text fg={theme.yellow} wrapMode="word">
                            ? {pending().request.message}
                        </text>
                        <text fg={theme.faint}>
                            y allow once
                            {pending().request.allowAlways ? ' · a always allow' : ''} ·
                            n deny
                        </text>
                    </box>
                )}
            </Show>
            <box flexDirection="row" justifyContent="space-between" marginTop={1}>
                <text fg={state().status === 'Failed' ? theme.red : theme.mint}>
                    {state().busy ? '◌' : '●'} {state().status}
                </text>
                <text fg={theme.faint}>
                    {usageLabel(state().totalTokens, state().costUsd)}
                    {state().busy ? 'ctrl+c cancel' : 'enter send · ctrl+c quit'}
                </text>
            </box>
        </box>
    );
}

function usageLabel(tokens: number | undefined, cost: number | undefined): string {
    const details: string[] = [];
    if (tokens !== undefined) details.push(`${tokens.toLocaleString()} tokens`);
    if (cost !== undefined) details.push(`$${cost.toFixed(4)}`);
    return details.length ? `${details.join(' · ')} · ` : '';
}
