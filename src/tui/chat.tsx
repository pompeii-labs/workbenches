import { useKeyboard } from '@opentui/solid';
import {
    type Accessor,
    createEffect,
    createMemo,
    createSignal,
    onCleanup,
    onMount,
    Show,
} from 'solid-js';
import { AuthoringCreateIncompleteError } from '../authoring/index.js';
import { RepositoryInspection } from '../repositories/index.js';
import { RunnerRegistry } from '../runners/registry.js';
import type {
    RunnerPermissionDecision,
    RunnerPermissionRequest,
    RunnerQuestionRequest,
    RunnerQuestionResponse,
} from '../runners/session.js';
import type { RunHandle } from '../runs/index.js';
import { SessionStore } from '../sessions/index.js';
import { startupLabel, usageLabel } from './activity.js';
import { ChatHeader } from './chat-header.js';
import type { ChatScreenProps } from './chat-types.js';
import { SessionCommands } from './commands/session.js';
import { Conversation } from './conversation.js';
import { useDialog } from './dialog/index.js';
import { showTranscriptOutcome } from './dialog/outcome.js';
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
import { RepositoryController } from './repository/controller.js';
import { RepositoryPanel } from './repository/panel.js';
import { RepositoryStrip } from './repository/strip.js';
import { consumeEvents, eventData, TurnCancellation } from './session.js';
import type { TranscriptCursor } from './session-transcript.js';
import { SessionTranscript } from './session-transcript.js';
import { useTheme } from './theme/index.js';

export function ChatScreen(props: ChatScreenProps) {
    const themes = useTheme();
    const { theme } = themes;
    const dialog = useDialog();
    const repository = new RepositoryController(
        props.resolved.repository,
        props.session?.repository,
        props.repositoryInspection ??
            ((id) =>
                new RepositoryInspection(
                    props.home,
                    id,
                    props.environment ?? process.env
                ))
    );
    const showRepository = () =>
        dialog.open(() => (
            <RepositoryPanel controller={repository} home={props.home} />
        ));
    const [state, setState] = createSignal(emptyTranscript());
    const [sessionReady, setSessionReady] = createSignal(false);
    const [sessionName, setSessionName] = createSignal(props.session?.name);
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
    let restoredReady = true;
    const observation = new AbortController();
    const cancellation = new TurnCancellation();
    const history = new PromptHistory(props.home);
    const sessions = new SessionStore(props.home);
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
                    const message =
                        cause instanceof Error ? cause.message : String(cause);
                    if (cause instanceof AuthoringCreateIncompleteError) {
                        const result = await props.operation.fail(
                            'Creator exited before creating a Workbench.'
                        );
                        await session?.close();
                        props.onAuthoringFinished?.(result);
                    } else {
                        leaving = false;
                        setError(message);
                        setState((current) => ({ ...current, status: 'Ready' }));
                        return;
                    }
                }
            }
        } else {
            await session?.detach().catch(() => {});
        }
        observation.abort();
        await storedTranscript()
            ?.flush()
            .catch(() => {});
        await props.resolved.cleanup();
        if (back) props.onBack();
        else props.onExit();
    };
    const browseSessions = async () => {
        if (leaving) return;
        if (props.operation) {
            setError(
                'Finish this authoring operation before resuming another session.'
            );
            return;
        }
        leaving = true;
        await decidePermission('reject');
        await respondToQuestion({ outcome: 'rejected' });
        observation.abort();
        await session?.detach().catch(() => {});
        await storedTranscript()
            ?.flush()
            .catch(() => {});
        await props.resolved.cleanup();
        props.onBrowseSessions();
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
    const showOutcome = () =>
        showTranscriptOutcome(props.home, state(), dialog, setError);
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
        if (terminal()) {
            setError('This run has finished. Use /resume to continue its session.');
            return;
        }
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
            if (!props.operation && !sessionName()) {
                const id = props.session?.id ?? session.runId;
                void sessions
                    .nameFromPrompt(id, task)
                    .then((updated) => {
                        if (!updated.name) return;
                        setSessionName(updated.name);
                        props.onSessionUpdated?.(updated);
                    })
                    .catch(() => {});
            }
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
        props.onSessionObserved?.(undefined);
        void history.load().catch((cause) => {
            setError(
                `Prompt history could not be loaded: ${cause instanceof Error ? cause.message : String(cause)}`
            );
        });
        try {
            if (props.session) {
                const transcript = new SessionTranscript(props.home, props.session.id);
                const restored = await transcript.restore();
                restoredReady = restored.ready !== false;
                setState(
                    restored.state ?? { ...emptyTranscript(), items: restored.items }
                );
                if (restored.cursor) setEventCursor(restored.cursor);
                setStoredTranscript(transcript);
            }
            session = await props.start({
                resolved: props.resolved,
                reference: props.alias,
                authoring: Boolean(props.operation),
                ...(props.session ? { session: props.session } : {}),
                ...(props.environment ? { environment: props.environment } : {}),
                ...(props.connection ? { connection: props.connection } : {}),
            });
            if (!props.operation) {
                props.onSessionObserved?.(props.session?.id ?? session.runId);
            }
            if (!storedTranscript()) {
                setStoredTranscript(new SessionTranscript(props.home, session.runId));
            }
            const cursor = eventCursor();
            await repository.attach(session.runId);
            const resumingObservedRun = cursor?.runId === session.runId;
            const afterSequence = resumingObservedRun ? cursor.sequence : undefined;
            if (resumingObservedRun && restoredReady) {
                setSessionReady(true);
                composer?.focus();
            }
            void consumeEvents(session, observation.signal, afterSequence, (event) => {
                repository.observe(event);
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
            const message = cause instanceof Error ? cause.message : String(cause);
            setError(message);
            if (props.operation) setTerminal({ status: 'failed', message });
            setState((current) => ({ ...current, status: 'Failed' }));
        }
    });
    onCleanup(() => {
        repository.dispose();
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
        if (key.defaultPrevented || dialog.active()) return;
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
        if (key.ctrl && key.name === 'g' && repository.available) {
            key.preventDefault();
            showRepository();
        } else if (key.name === 'escape' && (state().busy || cancellationPending())) {
            key.preventDefault();
            void cancelTurn();
        } else if (key.ctrl && key.name === 'c') {
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
        if (!sessionReady() && !error()) {
            return startupLabel(
                manifest.runtime,
                manifest.runner,
                state().status,
                Boolean(props.session)
            );
        }
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
        ...(repository.available
            ? {
                  repository: {
                      open: showRepository,
                      workspace: () =>
                          repository.state().status?.workspace ??
                          (props.resolved.workbench.manifest.runtime === 'local'
                              ? 'Preparing managed checkout'
                              : '/workspace'),
                  },
              }
            : {}),
        actions: {
            currentSessionId: () => props.session?.id ?? session?.runId,
            sessionRenamed: (updated) => {
                setSessionName(updated.name);
                props.onSessionUpdated?.(updated);
            },
            home: () => close(true),
            browseSessions,
            clearTranscript: () => setState((current) => ({ ...current, items: [] })),
            attachments,
            clearAttachments: () => setAttachments([]),
            improve,
            showOutcome,
            cancelTurn,
            exit: () => close(false),
            showError: setError,
        },
    });
    return (
        <box flexDirection="column" flexGrow={1} paddingX={3} paddingY={1}>
            <ChatHeader
                alias={props.alias}
                sessionName={sessionName()}
                manifest={manifest}
            />

            <RepositoryStrip controller={repository} />
            <Conversation
                items={transcript()}
                ready={sessionReady()}
                busy={state().busy}
                error={error()}
                activity={activityStatus()}
                assistantLabel={manifest.name}
                home={props.home}
                workspace={
                    repository.state().status?.workspace ??
                    props.resolved.workspaceDirectory
                }
            />

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
                                disabled={!sessionReady() && !terminal()}
                                {...(terminal()
                                    ? {
                                          placeholder:
                                              'Run finished. Type /outcome to inspect results, or /resume to continue',
                                      }
                                    : {})}
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
                          ? 'esc cancel'
                          : 'ctrl+c quit'}
                </text>
            </box>
        </box>
    );
}
