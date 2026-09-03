import { useKeyboard } from '@opentui/solid';
import {
    type Accessor,
    createMemo,
    createSignal,
    For,
    onCleanup,
    onMount,
    Show,
} from 'solid-js';

import { modelLabel } from '../models/index.js';
import { RunnerRegistry } from '../runners/registry.js';
import type {
    RunnerPermissionDecision,
    RunnerPermissionRequest,
    RunnerQuestionRequest,
    RunnerQuestionResponse,
} from '../runners/session.js';
import type { RunControlReceipt, RunHandle, WorkbenchEvent } from '../runs/index.js';
import type { ResolvedWorkbenchReference } from '../workbench/index.js';
import { ActivityIndicator } from './activity.js';
import { SessionCommands } from './commands/session.js';
import { useDialog } from './dialog/index.js';
import {
    addUserMessage,
    emptyTranscript,
    groupTranscriptItems,
    interruptTranscript,
    queueUserMessage,
    reduceTranscript,
    reduceTranscriptDuringCancellation,
    TranscriptEventBuffer,
} from './model.js';
import {
    PromptAttachmentReader,
    type PromptImageAttachment,
} from './prompt/attachments.js';
import { Composer, type ComposerRef } from './prompt/composer.js';
import { PromptHistory } from './prompt/history.js';
import { QuestionPrompt, questionFromEvent } from './question.js';
import { useTheme } from './theme/index.js';
import { Transcript } from './transcript.js';

export interface ChatScreenProps {
    home: string;
    alias: string;
    resolved: ResolvedWorkbenchReference;
    start: (options: {
        resolved: ResolvedWorkbenchReference;
        reference: string;
    }) => Promise<RunHandle>;
    onBack: () => void;
    onExit: () => void;
    homeAvailable: boolean;
}

export class TurnCancellation {
    private pendingRequest: Promise<RunControlReceipt> | undefined;

    get pending(): boolean {
        return this.pendingRequest !== undefined;
    }

    request(session: Pick<RunHandle, 'cancelTurn'>): Promise<RunControlReceipt> {
        if (this.pendingRequest) return this.pendingRequest;
        const pending = session.cancelTurn().finally(() => {
            if (this.pendingRequest === pending) this.pendingRequest = undefined;
        });
        this.pendingRequest = pending;
        return pending;
    }
}

export function ChatScreen(props: ChatScreenProps) {
    const themes = useTheme();
    const { theme } = themes;
    const dialog = useDialog();
    const [state, setState] = createSignal(emptyTranscript());
    const [sessionReady, setSessionReady] = createSignal(false);
    const [attachments, setAttachments] = createSignal<PromptImageAttachment[]>([]);
    const [error, setError] = createSignal('');
    const [permission, setPermission] = createSignal<{
        request: RunnerPermissionRequest;
    }>();
    const [question, setQuestion] = createSignal<RunnerQuestionRequest>();
    const [questionResponsePending, setQuestionResponsePending] = createSignal(false);
    const [cancellationPending, setCancellationPending] = createSignal(false);
    let session: RunHandle | undefined;
    const cancellation = new TurnCancellation();
    const history = new PromptHistory(props.home);
    const attachmentReader = new PromptAttachmentReader(
        props.resolved.workspaceDirectory
    );
    const imageInput = RunnerRegistry.standard().session(
        props.resolved.workbench.manifest.runner
    ).declaration.capabilities.image_input;
    let composer: ComposerRef | undefined;
    let leaving = false;
    const events = new TranscriptEventBuffer((event) =>
        setState((current) => {
            return cancellation.pending
                ? reduceTranscriptDuringCancellation(current, event)
                : reduceTranscript(current, event);
        })
    );

    const decidePermission = async (decision: RunnerPermissionDecision) => {
        const pending = permission();
        if (!pending) return;
        setPermission(undefined);
        setState((current) => ({ ...current, status: 'Working' }));
        try {
            await session?.respondToPermission(pending.request.id, decision);
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
        }
    };
    const respondToQuestion = async (response: RunnerQuestionResponse) => {
        const pending = question();
        if (!pending || questionResponsePending()) return;
        setQuestionResponsePending(true);
        setState((current) => ({ ...current, status: 'Submitting answer' }));
        try {
            await session?.respondToQuestion(pending.id, response);
            setQuestion(undefined);
            setState((current) => ({ ...current, status: 'Working' }));
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
            setState((current) => ({ ...current, status: 'Needs input' }));
        } finally {
            setQuestionResponsePending(false);
        }
    };
    const close = async (back: boolean) => {
        if (leaving) return;
        leaving = true;
        await decidePermission('reject');
        await respondToQuestion({ outcome: 'rejected' });
        await session?.close().catch(() => {});
        await props.resolved.cleanup();
        if (back) props.onBack();
        else props.onExit();
    };
    const cancelTurn = (): Promise<void> => {
        if (cancellation.pending) return Promise.resolve();
        const active = session;
        if (!active) return Promise.resolve();
        setError('');
        setCancellationPending(true);
        setState((current) => interruptTranscript(current));
        return cancellation
            .request(active)
            .then(() => undefined)
            .catch((cause) => {
                setError(cause instanceof Error ? cause.message : String(cause));
                setState((current) => ({
                    ...current,
                    interruptionPending: false,
                    status: 'Cancellation failed',
                }));
            })
            .finally(() => {
                setCancellationPending(false);
            });
    };
    const fail = (cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause));
        setState((current) => ({ ...current, busy: false, status: 'Failed' }));
    };
    const submit = async (value: string) => {
        const task = value.trim();
        if (!task || !session || permission() || question()) return;
        const steering = state().busy;
        const queuedId = steering ? crypto.randomUUID() : undefined;
        const images = attachments();
        const imageNames = images.map((image) => image.name);
        const input =
            images.length > 0
                ? {
                      text: task,
                      images: images.map(({ data, mimeType, name }) => ({
                          data,
                          mimeType,
                          name,
                      })),
                  }
                : task;
        setError('');
        setAttachments([]);
        setState((current) =>
            steering
                ? queueUserMessage(current, task, queuedId, imageNames)
                : addUserMessage(current, task, crypto.randomUUID(), imageNames)
        );
        try {
            if (steering) await session.steer(input);
            else await session.send(input);
        } catch (cause) {
            const message = cause instanceof Error ? cause.message : String(cause);
            setError(message);
            setAttachments((current) => [...images, ...current]);
            setState((current) => ({
                ...current,
                ...(queuedId
                    ? {
                          queued: current.queued.filter(
                              (input) => input.id !== queuedId
                          ),
                      }
                    : {}),
                busy: false,
                status: 'Failed',
            }));
        }
    };
    const paste = async (value: string): Promise<boolean> => {
        try {
            const image = await attachmentReader.readPasted(value);
            if (!image) return false;
            if (imageInput.status === 'unsupported') {
                setError(
                    imageInput.detail ??
                        `${props.resolved.workbench.manifest.runner} does not support image input`
                );
                return true;
            }
            setAttachments((current) =>
                current.some((attachment) => attachment.path === image.path)
                    ? current
                    : [...current, image]
            );
            setError('');
            return true;
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
            return true;
        }
    };

    onMount(async () => {
        void history.load().catch((cause) => {
            setError(
                `Prompt history could not be loaded: ${cause instanceof Error ? cause.message : String(cause)}`
            );
        });
        try {
            session = await props.start({
                resolved: props.resolved,
                reference: props.alias,
            });
            setSessionReady(true);
            void consumeEvents(session, (event) => {
                const requested = permissionFromEvent(event);
                if (requested) setPermission({ request: requested });
                const asked = questionFromEvent(event);
                if (asked) setQuestion(asked);
                if (
                    (event.type === 'question.answered' ||
                        event.type === 'question.rejected') &&
                    object(event.data)?.id === question()?.id
                ) {
                    setQuestion(undefined);
                }
                events.push(event);
            }).catch(fail);
            void session.result.catch(fail);
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
            void decidePermission('reject');
            void respondToQuestion({ outcome: 'rejected' });
            void session?.close().catch(() => {});
            void props.resolved.cleanup();
        }
    });
    useKeyboard((key) => {
        if (dialog.active()) return;
        const pendingQuestion = question();
        if (pendingQuestion) {
            if (key.ctrl && key.name === 'c') {
                key.preventDefault();
                void respondToQuestion({ outcome: 'rejected' });
                void cancelTurn();
            }
            return;
        }
        const pending = permission();
        if (pending) {
            if (key.ctrl && key.name === 'c') {
                key.preventDefault();
                void decidePermission('reject');
                void cancelTurn();
                return;
            }
            if (key.name === 'y') {
                key.preventDefault();
                void decidePermission('allow_once');
                return;
            }
            if (key.name === 'a' && pending.request.allowAlways) {
                key.preventDefault();
                void decidePermission('allow_always');
                return;
            }
            if (key.name === 'n' || key.name === 'escape') {
                key.preventDefault();
                void decidePermission('reject');
                return;
            }
        }
        if (key.ctrl && key.name === 'c') {
            key.preventDefault();
            if (state().busy || cancellationPending()) void cancelTurn();
            else void close(false);
        } else if (key.name === 'escape' && props.homeAvailable && !state().busy) {
            key.preventDefault();
            void close(true);
        }
    });

    const manifest = props.resolved.workbench.manifest;
    const transcript = createMemo(() => groupTranscriptItems(state().items));
    const activityStatus = createMemo(() => {
        if (!state().busy || permission() || question()) return;
        if (state().status === 'Responding') return;
        const latest = transcript().at(-1);
        if (
            state().status === 'Working' &&
            latest?.kind === 'activity' &&
            latest.tools.some((tool) => tool.status === 'running')
        ) {
            return;
        }
        return state().status;
    });
    const commands = new SessionCommands({
        home: props.home,
        alias: props.alias,
        resolved: props.resolved,
        dialog,
        themes,
        actions: {
            currentRunId: () => session?.runId,
            clearTranscript: () => setState((current) => ({ ...current, items: [] })),
            cancelTurn,
            exit: () => close(false),
            showError: setError,
        },
    });
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
                <For each={transcript()} fallback={<box height={0} />}>
                    {(item, index) => (
                        <Transcript
                            item={item}
                            assistantLabel={manifest.name}
                            streaming={
                                item.kind === 'assistant' &&
                                state().busy &&
                                index() === transcript().length - 1
                            }
                        />
                    )}
                </For>
                <Show when={activityStatus()}>
                    {(status: () => string) => (
                        <box marginTop={1}>
                            <ActivityIndicator label={status()} />
                        </box>
                    )}
                </Show>
                <Show when={error().length > 0} fallback={<box height={0} />}>
                    <box
                        border={['left']}
                        borderColor={theme.red}
                        paddingLeft={1}
                        marginTop={1}
                    >
                        <text fg={theme.red}>{error()}</text>
                    </box>
                </Show>
            </scrollbox>

            <Show
                when={question()}
                fallback={
                    <Show
                        when={permission()}
                        fallback={
                            <Composer
                                ref={(value) => {
                                    composer = value;
                                }}
                                busy={state().busy}
                                disabled={!sessionReady()}
                                acceptsImages={imageInput.status !== 'unsupported'}
                                queued={state().queued}
                                attachments={attachments()}
                                history={history}
                                commands={commands.registry}
                                onSubmit={submit}
                                onPaste={paste}
                                onCommand={(command, argument) =>
                                    commands.run(command, argument)
                                }
                                onUnknownCommand={(name) =>
                                    setError(
                                        `Unknown command: ${name}. Type /help to browse commands.`
                                    )
                                }
                                onOpenPalette={() => commands.openPalette()}
                            />
                        }
                    >
                        {(
                            pending: Accessor<{
                                request: RunnerPermissionRequest;
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
                                    {pending().request.allowAlways
                                        ? ' · a always allow'
                                        : ''}{' '}
                                    · n deny
                                </text>
                            </box>
                        )}
                    </Show>
                }
            >
                {(pending: Accessor<RunnerQuestionRequest>) => (
                    <QuestionPrompt
                        request={pending()}
                        disabled={questionResponsePending()}
                        onRespond={(response) => void respondToQuestion(response)}
                    />
                )}
            </Show>
            <box flexDirection="row" justifyContent="flex-end" marginTop={1}>
                <text fg={theme.faint}>
                    {usageLabel(state().totalTokens, state().costUsd)}
                    {question()
                        ? 'answer required · ctrl+c cancel'
                        : state().busy || cancellationPending()
                          ? 'ctrl+c cancel'
                          : 'ctrl+c quit'}
                </text>
            </box>
        </box>
    );
}

async function consumeEvents(
    session: RunHandle,
    consume: (event: WorkbenchEvent) => void
): Promise<void> {
    for await (const event of session.events) consume(event);
}

function permissionFromEvent(
    event: WorkbenchEvent
): RunnerPermissionRequest | undefined {
    if (event.type !== 'input.requested') return undefined;
    const data = object(event.data);
    const id = string(data?.id);
    const action = string(data?.action);
    const message = string(data?.message);
    if (!id || !action || !message) return undefined;
    return {
        id,
        action,
        message,
        resources: strings(data?.resources),
        allowAlways: strings(data?.options).includes('allow_always'),
    };
}

function usageLabel(tokens: number | undefined, cost: number | undefined): string {
    const details: string[] = [];
    if (tokens !== undefined) details.push(`${tokens.toLocaleString()} tokens`);
    if (cost !== undefined) details.push(`$${cost.toFixed(4)}`);
    return details.length ? `${details.join(' · ')} · ` : '';
}

function object(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
}

function string(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function strings(value: unknown): string[] {
    return Array.isArray(value)
        ? value.filter((item): item is string => typeof item === 'string')
        : [];
}
