import { describe, expect, test } from 'bun:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { todoReminderPlugin } from '../../../src/runners/opencode/todo-reminder.js';

type Hook = (
    input: { tool: string; sessionID: string; args?: unknown },
    output: { output: string }
) => Promise<void>;

async function plugin() {
    const directory = await mkdtemp(join(tmpdir(), 'wb-todo-reminder-'));
    const path = join(directory, 'wb-todo-reminder.js');
    await writeFile(path, todoReminderPlugin);
    const module = await import(path);
    expect(Object.keys(module)).toEqual(['WbTodoReminder']);
    let time = 0;
    const hooks = await module.WbTodoReminder({}, { now: () => time });
    const hook: Hook = hooks['tool.execute.after'];
    return {
        tick: (ms: number) => {
            time += ms;
        },
        todos: (statuses: string[], sessionID = 's') =>
            hook(
                {
                    tool: 'todowrite',
                    sessionID,
                    args: { todos: statuses.map((status) => ({ status })) },
                },
                { output: '' }
            ),
        call: async (sessionID = 's') => {
            const output = { output: 'ok' };
            await hook({ tool: 'bash', sessionID }, output);
            return output.output;
        },
    };
}

describe('todo reminder plugin', () => {
    test('stays quiet before the agent writes a list', async () => {
        const run = await plugin();
        for (let i = 0; i < 20; i++) expect(await run.call()).toBe('ok');
    });

    test('reminds after ten calls without an update, then again ten later', async () => {
        const run = await plugin();
        await run.todos(['in_progress', 'pending']);
        for (let i = 0; i < 9; i++) expect(await run.call()).toBe('ok');
        expect(await run.call()).toContain('has not changed in 10 tool calls');
        for (let i = 0; i < 9; i++) expect(await run.call()).toBe('ok');
        expect(await run.call()).toContain('<system-reminder>');
    });

    test('reminds after three idle minutes', async () => {
        const run = await plugin();
        await run.todos(['in_progress']);
        run.tick(3 * 60 * 1000);
        expect(await run.call()).toContain('has not changed in 3 minutes');
        expect(await run.call()).toBe('ok');
    });

    test('an update resets the count', async () => {
        const run = await plugin();
        await run.todos(['in_progress']);
        for (let i = 0; i < 9; i++) await run.call();
        await run.todos(['completed', 'in_progress']);
        expect(await run.call()).toBe('ok');
    });

    test('a finished list ends the reminders', async () => {
        const run = await plugin();
        await run.todos(['completed', 'cancelled']);
        for (let i = 0; i < 20; i++) expect(await run.call()).toBe('ok');
    });

    test('tracks each session on its own', async () => {
        const run = await plugin();
        await run.todos(['in_progress'], 'a');
        for (let i = 0; i < 20; i++) expect(await run.call('b')).toBe('ok');
        for (let i = 0; i < 9; i++) await run.call('a');
        expect(await run.call('a')).toContain('<system-reminder>');
    });
});
