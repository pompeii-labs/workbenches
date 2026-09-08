import { useKeyboard } from '@opentui/solid';
import {
    type Accessor,
    createEffect,
    createMemo,
    createSignal,
    Index,
    onCleanup,
    onMount,
    Show,
} from 'solid-js';
import type {
    AuthoringOperation,
    AuthoringOperationResult,
} from '../authoring/index.js';
import { modelLabel } from '../models/index.js';
import { RunnerRegistry } from '../runners/registry.js';
import type {
    RunnerPermissionDecision,
    RunnerPermissionRequest,
    RunnerQuestionRequest,
    RunnerQuestionResponse,
} from '../runners/session.js';
import type { RunHandle } from '../runs/index.js';
import type { ResolvedSession, StoredSession } from '../sessions/index.js';
import type { ResolvedWorkbenchReference } from '../workbench/index.js';
import { ActivityIndicator, usageLabel } from './activity.js';
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
import { PermissionPrompt, permissionFromEvent } from './permission.js';
import {
    PromptAttachmentReader,
    type PromptImageAttachment,
} from './prompt/attachments.js';
import { Composer, type ComposerRef } from './prompt/composer.js';
import { PromptHistory } from './prompt/history.js';
import { QuestionPrompt, questionFromEvent } from './question.js';
import { consumeEvents, eventData, TurnCancellation } from './session.js';
import type { TranscriptCursor } from './session-transcript.js';
import { SessionTranscript } from './session-transcript.js';
import { useTheme } from './theme/index.js';
import { Transcript } from './transcript.js';

export interface ChatScreenProps {
    home: string;
    alias: string;
    resolved: ResolvedWorkbenchReference;
    start: (options: {
        resolved: ResolvedWorkbenchReference;
        reference: string;
        session?: StoredSession;
        environment?: Record<string, string | undefined>;
    }) => Promise<RunHandle>;
    session?: StoredSession;
    initialPrompt?: string;
    operation?: AuthoringOperation;
    environment?: Record<string, string | undefined>;
    resolveSession?: (id: string) => Promise<ResolvedSession>;
    prepareImprovement?: (
        sessionId: string,
        feedback: string
    ) => Promise<PreparedWorkbenchChat>;
    onAuthoring?: (launch: PreparedWorkbenchChat) => void;
    onAuthoringFinished?: (result: AuthoringOperationResult) => void;
    onResume: (session: ResolvedSession) => void;
    onBack: () => void;
    onExit: () => void;
    homeAvailable: boolean;
}

export interface PreparedWorkbenchChat {
    alias: string;
    resolved: ResolvedWorkbenchReference;
    prompt: string;
    operation?: AuthoringOperation;
    environment?: Record<string, string | undefined>;
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
    const [terminal, setTerminal] = createSignal<{
        status: 'completed' | 'failed' | 'cancelled';
        message?: string;
    }>();
    const [storedTranscript, setStoredTranscript] = createSignal<SessionTranscript>();
    const [eventCursor, setEventCursor] = createSignal<TranscriptCursor>();
    let session: RunHandle | undefined;
    const observation = new AbortController();
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
    let initialPromptSubmitted = false;
    const events = new TranscriptEventBuffer((event) =>
        setState((current) => {
            return current.interruptionPending
                ? reduceTranscriptDuringCancellation(current, event)
                : reduceTranscript(current, event);
        })
    );

    createEffect(() => {
        const transcript = storedTranscript();
        const items = state().items;
        if (transcript) transcript.schedule(items, eventCursor());
    });

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
        if (props.operation && state().busy && !terminal()) {
            setError(
                'Finish or cancel the active creator turn before completing authoring.'
            );
            return;
        }
        leaving = true;
        await decidePermission('reject');
        await respondToQuestion({ outcome: 'rejected' });
        if (props.operation) {
            const stopped = terminal();
            if (stopped?.status === 'failed' || stopped?.status === 'cancelled') {
                const result = await props.operation.fail(
                    stopped.message ?? `Creator run ${stopped.status}`
                );
                props.onAuthoringFinished?.(result);
            } else {
                setState((current) => ({ ...current, status: 'Verifying' }));
                try {
                    const result = await props.operation.finish();
                    await session?.close();
                    props.onAuthoringFinished?.(result);
                } catch (cause) {
                    leaving = false;
                    setError(cause instanceof Error ? cause.message : String(cause));
                    setState((current) => ({ ...current, status: 'Ready' }));
                    return;
                }
            }
        }
        observation.abort();
        if (!props.operation) await session?.detach().catch(() => {});
        await storedTranscript()
            ?.flush()
            .catch(() => {});
        await props.resolved.cleanup();
        if (back) props.onBack();
        else props.onExit();
    };
    const resume = async (target: StoredSession) => {
        if (leaving || state().busy) {
            setError(
                'Finish or cancel the active turn before resuming another session.'
            );
            return;
        }
        if (!props.resolveSession) {
            setError('Session resume is unavailable.');
            return;
        }
        if (props.operation) {
            setError(
                'Finish this authoring operation before resuming another session.'
            );
            return;
        }
        let resolved: ResolvedSession;
        try {
            resolved = await props.resolveSession(target.id);
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
            return;
        }
        leaving = true;
        observation.abort();
        await session?.detach().catch(() => {});
        await storedTranscript()
            ?.flush()
            .catch(() => {});
        await props.resolved.cleanup();
        props.onResume(resolved);
    };
    const improve = async (feedback: string) => {
        if (leaving || state().busy) {
            setError(
                'Finish or cancel the active turn before improving this Workbench.'
            );
            return;
        }
        if (!props.prepareImprovement || !props.onAuthoring) {
            setError('Workbench improvement is unavailable.');
            return;
        }
        const sessionId = props.session?.id ?? session?.runId;
        if (!sessionId) {
            setError('This Workbench session is not ready to improve.');
            return;
        }
        setError('');
        setState((current) => ({ ...current, status: 'Preparing improvement' }));
        try {
            await storedTranscript()?.flush();
            const launch = await props.prepareImprovement(sessionId, feedback);
            leaving = true;
            observation.abort();
            await session?.detach().catch(() => {});
            await props.resolved.cleanup();
            props.onAuthoring(launch);
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
            setState((current) => ({ ...current, status: 'Ready' }));
        }
    };
    const cancelTurn = (): Promise<void> => {
        if (cancellation.pending) return Promise.resolve();
        const active = session;
        if (!active) return Promise.resolve();
        setError('');
        setCancellationPending(true);
        events.discardText();
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
            if (props.session) {
                const transcript = new SessionTranscript(props.home, props.session.id);
                setStoredTranscript(transcript);
                const [items, cursor] = await Promise.all([
                    transcript.load(),
                    transcript.cursor(),
                ]);
                if (items.length > 0) {
                    setState((current) => ({ ...current, items }));
                }
                if (cursor) setEventCursor(cursor);
            }
            session = await props.start({
                resolved: props.resolved,
                reference: props.alias,
                ...(props.session ? { session: props.session } : {}),
                ...(props.environment ? { environment: props.environment } : {}),
            });
            if (!storedTranscript()) {
                setStoredTranscript(new SessionTranscript(props.home, session.runId));
            }
            const cursor = eventCursor();
            const resumingObservedRun = cursor?.runId === session.runId;
            const afterSequence = resumingObservedRun ? cursor.sequence : undefined;
            if (resumingObservedRun) {
                setSessionReady(true);
                composer?.focus();
            }
            void consumeEvents(session, observation.signal, afterSequence, (event) => {
                if (event.type === 'run.ready') {
                    setSessionReady(true);
                    composer?.focus();
                    if (props.initialPrompt && !initialPromptSubmitted) {
                        initialPromptSubmitted = true;
                        queueMicrotask(
                            () => void submit(props.initialPrompt as string)
                        );
                    }
                } else if (
                    event.type === 'run.failed' ||
                    event.type === 'run.cancelled' ||
                    event.type === 'run.completed'
                ) {
                    setSessionReady(false);
                    const data = eventData(event.data);
                    setTerminal({
                        status:
                            event.type === 'run.failed'
                                ? 'failed'
                                : event.type === 'run.cancelled'
                                  ? 'cancelled'
                                  : 'completed',
                        ...(typeof data?.message === 'string'
                            ? { message: data.message }
                            : {}),
                    });
                }
                const requested = permissionFromEvent(event);
                if (requested) setPermission({ request: requested });
                const asked = questionFromEvent(event);
                if (asked) setQuestion(asked);
                if (
                    (event.type === 'question.answered' ||
                        event.type === 'question.rejected') &&
                    eventData(event.data)?.id === question()?.id
                ) {
                    setQuestion(undefined);
                }
                events.push(event);
                setEventCursor({ runId: event.run_id, sequence: event.sequence });
            }).catch(fail);
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
            setState((current) => ({ ...current, status: 'Failed' }));
        }
    });
    onCleanup(() => {
        events.dispose();
        if (!leaving) {
            leaving = true;
            observation.abort();
            void decidePermission('reject');
            void respondToQuestion({ outcome: 'rejected' });
            void session?.detach().catch(() => {});
            void storedTranscript()
                ?.flush()
                .catch(() => {});
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
        authoring: Boolean(props.operation),
        actions: {
            currentSessionId: () => props.session?.id ?? session?.runId,
            resumeSession: resume,
            clearTranscript: () => setState((current) => ({ ...current, items: [] })),
            attachments,
            clearAttachments: () => setAttachments([]),
            improve,
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
                        <Show
                            when={sessionReady()}
                            fallback={
                                <text fg={theme.muted}>
                                    Starting {manifest.name}...
                                </text>
                            }
                        >
                            <text fg={theme.muted}>Ready when you are.</text>
                            <text fg={theme.faint}>
                                This session keeps its context across every turn.
                            </text>
                        </Show>
                    </box>
                </Show>
                <Index each={transcript()} fallback={<box height={0} />}>
                    {(item, index) => (
                        <Transcript
                            item={item()}
                            assistantLabel={manifest.name}
                            workspace={props.resolved.workspaceDirectory}
                            streaming={
                                item().kind === 'assistant' &&
                                state().busy &&
                                index === transcript().length - 1
                            }
                        />
                    )}
                </Index>
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
                        {(pending: Accessor<{ request: RunnerPermissionRequest }>) => (
                            <PermissionPrompt request={pending().request} />
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
