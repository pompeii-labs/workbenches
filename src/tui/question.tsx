import type { SelectOption, SelectRenderable } from '@opentui/core';
import { useKeyboard } from '@opentui/solid';
import { createMemo, createSignal, Show } from 'solid-js';

import type {
    RunnerQuestionPrompt,
    RunnerQuestionRequest,
    RunnerQuestionResponse,
} from '../runners/session.js';
import type { WorkbenchEvent } from '../runs/index.js';
import { theme } from './theme.js';

interface QuestionPromptProps {
    request: RunnerQuestionRequest;
    disabled?: boolean;
    onRespond: (response: RunnerQuestionResponse) => void;
}

type Choice = { kind: 'option'; label: string } | { kind: 'custom' } | { kind: 'done' };

export function QuestionPrompt(props: QuestionPromptProps) {
    let selector: SelectRenderable | undefined;
    const [index, setIndex] = createSignal(0);
    const [answers, setAnswers] = createSignal<string[][]>([]);
    const [selected, setSelected] = createSignal<string[]>([]);
    const [custom, setCustom] = createSignal(false);
    const current = createMemo(() => props.request.questions[index()]);
    const options = createMemo(() => questionOptions(current(), selected()));
    const textInput = createMemo(() => custom() || current()?.options.length === 0);
    const selectHeight = createMemo(() =>
        Math.min(Math.max(options().length * 2, 2), 10)
    );
    const promptHeight = createMemo(() => (textInput() ? 6 : selectHeight() + 5));

    const complete = (answer: string[]) => {
        const next = [...answers(), answer];
        if (index() + 1 < props.request.questions.length) {
            setAnswers(next);
            setIndex(index() + 1);
            setSelected([]);
            setCustom(false);
            return;
        }
        props.onRespond({ outcome: 'answered', answers: next });
    };
    const choose = (_index: number, option: SelectOption | null) => {
        if (props.disabled) return;
        const choice = option?.value as Choice | undefined;
        const question = current();
        if (!choice || !question) return;
        if (choice.kind === 'custom') {
            setCustom(true);
            return;
        }
        if (choice.kind === 'done') {
            if (selected().length > 0) complete(selected());
            return;
        }
        if (!question.multiple) {
            complete([choice.label]);
            return;
        }
        setSelected((values) =>
            values.includes(choice.label)
                ? values.filter((value) => value !== choice.label)
                : [...values, choice.label]
        );
    };
    const answerCustom = (value: string) => {
        if (props.disabled) return;
        const answer = value.trim();
        if (!answer) return;
        complete(current()?.multiple ? [...selected(), answer] : [answer]);
    };

    useKeyboard((key) => {
        if (props.disabled) {
            if (!(key.ctrl && key.name === 'c')) key.preventDefault();
            return;
        }
        if (key.name === 'escape') {
            key.preventDefault();
            if (custom()) setCustom(false);
            else props.onRespond({ outcome: 'rejected' });
            return;
        }
        if (textInput()) return;
        if (key.name === 'up' || key.name === 'down') {
            key.preventDefault();
            if (key.name === 'up') selector?.moveUp();
            else selector?.moveDown();
            return;
        }
        if (key.name === 'enter' || key.name === 'return' || key.name === 'linefeed') {
            key.preventDefault();
            selector?.selectCurrent();
        }
    });

    return (
        <box
            minHeight={promptHeight()}
            border={true}
            borderStyle="rounded"
            borderColor={theme.yellow}
            backgroundColor={theme.panelRaised}
            paddingX={1}
            flexDirection="column"
        >
            <box flexDirection="row" justifyContent="space-between">
                <text fg={theme.yellow}>? {current()?.header ?? 'Question'}</text>
                <Show when={props.request.questions.length > 1} fallback={<text />}>
                    <text fg={theme.faint}>
                        {index() + 1}/{props.request.questions.length}
                    </text>
                </Show>
            </box>
            <text fg={theme.text} wrapMode="word">
                {current()?.question}
            </text>
            <Show
                when={textInput()}
                fallback={
                    <select
                        ref={(value) => {
                            selector = value;
                            value.focus();
                        }}
                        options={options()}
                        height={selectHeight()}
                        backgroundColor={theme.panelRaised}
                        focusedBackgroundColor={theme.panelRaised}
                        textColor={theme.muted}
                        focusedTextColor={theme.text}
                        selectedBackgroundColor={theme.panelRaised}
                        selectedTextColor={theme.accent}
                        descriptionColor={theme.faint}
                        selectedDescriptionColor={theme.muted}
                        showScrollIndicator={true}
                        wrapSelection={true}
                        onSelect={choose}
                    />
                }
            >
                <input
                    ref={(value) => value.focus()}
                    placeholder="Type your answer"
                    placeholderColor={theme.faint}
                    textColor={theme.text}
                    focusedTextColor={theme.text}
                    backgroundColor={theme.panelRaised}
                    focusedBackgroundColor={theme.panelRaised}
                    on:enter={answerCustom}
                />
            </Show>
            <text fg={theme.faint}>
                {props.disabled
                    ? 'Submitting answer…'
                    : textInput()
                      ? `enter submit · esc ${custom() ? 'back' : 'dismiss'}`
                      : current()?.multiple
                        ? '↑↓ navigate · enter toggle/done · esc dismiss'
                        : '↑↓ navigate · enter select · esc dismiss'}
            </text>
        </box>
    );
}

export function questionFromEvent(
    event: WorkbenchEvent
): RunnerQuestionRequest | undefined {
    if (event.type !== 'question.requested') return undefined;
    const data = object(event.data);
    const id = string(data?.id);
    if (!id || !Array.isArray(data?.questions)) return undefined;
    const questions = data.questions
        .map(questionFromValue)
        .filter((question): question is RunnerQuestionPrompt => Boolean(question));
    return questions.length === data.questions.length && questions.length > 0
        ? { id, questions }
        : undefined;
}

function questionOptions(
    question: RunnerQuestionPrompt | undefined,
    selected: string[]
): SelectOption[] {
    if (!question) return [];
    const options: SelectOption[] = question.options.map((option) => ({
        name: question.multiple
            ? `${selected.includes(option.label) ? '●' : '○'} ${option.label}`
            : option.label,
        description: option.description ?? '',
        value: { kind: 'option', label: option.label } satisfies Choice,
    }));
    if (question.custom) {
        options.push({
            name: 'Type an answer',
            description: 'Provide a custom response',
            value: { kind: 'custom' } satisfies Choice,
        });
    }
    if (question.multiple) {
        options.push({
            name: selected.length > 0 ? 'Done' : 'Select at least one',
            description: '',
            value: { kind: 'done' } satisfies Choice,
        });
    }
    return options;
}

function questionFromValue(value: unknown): RunnerQuestionPrompt | undefined {
    const question = object(value);
    const prompt = string(question?.question);
    if (!question || !prompt || !Array.isArray(question.options)) return undefined;
    const options = question.options
        .map((value) => {
            const option = object(value);
            const label = string(option?.label);
            if (!option || !label) return undefined;
            const description = string(option.description);
            return { label, ...(description ? { description } : {}) };
        })
        .filter((option): option is NonNullable<typeof option> => Boolean(option));
    if (options.length !== question.options.length) return undefined;
    const header = string(question.header);
    return {
        question: prompt,
        ...(header ? { header } : {}),
        options,
        multiple: question.multiple === true,
        custom: question.custom === true,
    };
}

function object(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
}

function string(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}
