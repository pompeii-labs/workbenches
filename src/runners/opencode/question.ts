import type { RunnerQuestionPrompt, RunnerQuestionResponse } from '../session.js';
import { record, string } from './json.js';

export class OpenCodeQuestion {
    fromNative(value: unknown): RunnerQuestionPrompt[] {
        if (!Array.isArray(value) || value.length === 0) {
            throw new Error('OpenCode emitted an invalid question request');
        }
        return value.map((entry) => this.prompt(entry));
    }

    answers(
        questions: RunnerQuestionPrompt[],
        response: Extract<RunnerQuestionResponse, { outcome: 'answered' }>
    ): string[][] {
        if (response.answers.length !== questions.length) {
            throw new Error('Workbench question response count does not match request');
        }
        return response.answers.map((answer, index) => {
            const question = questions[index];
            if (!question || answer.length === 0) {
                throw new Error('Workbench question response must not be empty');
            }
            if (!question.multiple && answer.length > 1) {
                throw new Error('Workbench question response has too many selections');
            }
            const allowed = new Set(question.options.map((option) => option.label));
            const normalized = answer.map((value) => value.trim()).filter(Boolean);
            if (
                normalized.length !== answer.length ||
                (!question.custom && normalized.some((value) => !allowed.has(value)))
            ) {
                throw new Error(
                    'Workbench question response contains an invalid answer'
                );
            }
            return normalized;
        });
    }

    private prompt(value: unknown): RunnerQuestionPrompt {
        const question = record(value);
        const prompt = string(question?.question);
        if (!question || !prompt || !Array.isArray(question.options)) {
            throw new Error('OpenCode emitted an invalid question prompt');
        }
        const options = question.options.map((entry) => {
            const option = record(entry);
            const label = string(option?.label);
            if (!option || !label) {
                throw new Error('OpenCode emitted an invalid question option');
            }
            const description = string(option.description);
            return { label, ...(description ? { description } : {}) };
        });
        const header = string(question.header);
        return {
            question: prompt,
            ...(header ? { header } : {}),
            options,
            multiple: question.multiple === true,
            custom: question.custom !== false,
        };
    }
}
