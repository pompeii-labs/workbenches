import { describe, expect, test } from 'bun:test';
import { PiInputRequests } from '../../../src/runners/pi/requests.js';
import type {
    RunnerQuestionRequest,
    RunnerQuestionResponse,
} from '../../../src/runners/session.js';

function fixture() {
    const questions: RunnerQuestionRequest[] = [];
    const sent: Record<string, unknown>[] = [];
    const withdrawn: string[] = [];
    let answer: (response: RunnerQuestionResponse) => void = () => {};
    const requests = new PiInputRequests(
        {
            requestQuestion: (request) => {
                questions.push(request);
                return new Promise((resolve) => {
                    answer = resolve;
                });
            },
            withdrawRequest: async (id) => {
                withdrawn.push(id);
            },
        },
        async (response) => {
            sent.push(response);
        },
        async (id) => {
            withdrawn.push(id);
        }
    );
    return {
        requests,
        questions,
        sent,
        withdrawn,
        answer: (response: RunnerQuestionResponse) => answer(response),
    };
}

describe('Pi native extension questions', () => {
    for (const method of ['select', 'confirm', 'input', 'editor']) {
        test(`maps ${method} and returns the matching native response`, async () => {
            const f = fixture();
            const pending = f.requests.handle({
                type: 'extension_ui_request',
                id: 'dialog-1',
                method,
                title: 'Choose',
                options: ['First', 'Second'],
                message: 'Continue?',
                placeholder: 'hint',
                prefill: 'MUST_NOT_PERSIST_PREFILL',
                unrelated: 'MUST_NOT_PERSIST_NATIVE_PAYLOAD',
            });
            expect(f.questions).toEqual([
                {
                    id: 'dialog-1',
                    questions: [
                        {
                            question:
                                method === 'confirm' ? 'Choose\n\nContinue?' : 'Choose',
                            options: (method === 'select'
                                ? ['First', 'Second']
                                : method === 'confirm'
                                  ? ['Yes', 'No']
                                  : []
                            ).map((label) => ({ label })),
                            multiple: false,
                            custom: method === 'input' || method === 'editor',
                        },
                    ],
                },
            ]);
            const value =
                method === 'select'
                    ? 'Second'
                    : method === 'confirm'
                      ? 'Yes'
                      : 'free\ntext';
            f.answer({ outcome: 'answered', answers: [[value]] });
            await pending;
            expect(f.sent).toEqual([
                {
                    type: 'extension_ui_response',
                    id: 'dialog-1',
                    ...(method === 'confirm' ? { confirmed: true } : { value }),
                },
            ]);
        });
    }

    test('returns a negative confirmation and cancellation on rejection', async () => {
        const f = fixture();
        const no = f.requests.handle({
            id: 'no',
            method: 'confirm',
            title: 'Continue?',
        });
        f.answer({ outcome: 'answered', answers: [['No']] });
        await no;
        const rejected = f.requests.handle({
            id: 'reject',
            method: 'input',
            title: 'Value?',
        });
        f.answer({ outcome: 'rejected' });
        await rejected;
        expect(f.sent).toEqual([
            { type: 'extension_ui_response', id: 'no', confirmed: false },
            { type: 'extension_ui_response', id: 'reject', cancelled: true },
        ]);
    });

    test('withdraws timed-out dialogs without replying or accepting a late answer', async () => {
        const f = fixture();
        await f.requests.handle({
            id: 'timeout',
            method: 'input',
            title: 'Value?',
            timeout: 5,
        });
        expect(f.withdrawn).toEqual(['timeout']);
        f.answer({ outcome: 'answered', answers: [['late']] });
        await Bun.sleep(0);
        expect(f.sent).toEqual([]);
    });

    test('withdraws pending dialogs at a turn boundary and session close', async () => {
        const f = fixture();
        const first = f.requests.handle({
            id: 'turn',
            method: 'editor',
            title: 'Edit',
        });
        await f.requests.withdrawAll();
        await first;
        const second = f.requests.handle({
            id: 'session',
            method: 'select',
            title: 'Choose',
            options: ['One'],
        });
        await f.requests.close();
        await second;
        f.answer({ outcome: 'answered', answers: [['One']] });
        expect(f.withdrawn).toEqual(['turn', 'session']);
        expect(f.sent).toEqual([]);
    });

    test('ignores fire-and-forget methods', async () => {
        const f = fixture();
        for (const method of [
            'notify',
            'setStatus',
            'setWidget',
            'setTitle',
            'set_editor_text',
        ]) {
            await f.requests.handle({ id: method, method, title: 'Ignored' });
        }
        expect(f.questions).toEqual([]);
        expect(f.sent).toEqual([]);
    });
});
