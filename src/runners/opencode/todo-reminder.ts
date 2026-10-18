/**
 * Agents batch todo updates: ten items finish, then the list changes all at
 * once, and progress reads as stalled in between. This OpenCode plugin nudges
 * the agent instead of guessing for it. Once the agent has a list with open
 * items, a list unchanged for `calls` tool calls or `ms` milliseconds earns a
 * one-line reminder at the end of the next tool result. The list stays the
 * agent's own, and appending to a tool result leaves the prompt cache intact.
 *
 * OpenCode loads every `plugin/*.js` in its config directory and treats each
 * export as a plugin, so the source exports exactly one function and imports
 * nothing: the staged directory is read-only and runs may have no network.
 */

/** Where the plugin lands inside the staged OpenCode config directory. */
export const todoReminderPluginPath = 'plugin/wb-todo-reminder.js';

/** Tool calls without a list update before a reminder. */
export const todoReminderCalls = 10;

/** Milliseconds without a list update before a reminder. */
export const todoReminderMs = 3 * 60 * 1000;

export const todoReminderPlugin = `// Written by wb for this run. See todo-reminder.ts in the wb source.
const calls = ${todoReminderCalls};
const ms = ${todoReminderMs};

export const WbTodoReminder = async (_input, options) => {
    const now = options?.now ?? Date.now;
    const sessions = new Map();
    return {
        'tool.execute.after': async (input, output) => {
            const state = sessions.get(input.sessionID) ?? { open: false };
            sessions.set(input.sessionID, state);
            if (input.tool === 'todowrite') {
                const todos = Array.isArray(input.args?.todos) ? input.args.todos : [];
                state.open = todos.some(
                    (todo) => todo?.status !== 'completed' && todo?.status !== 'cancelled'
                );
                state.calls = 0;
                state.since = now();
                return;
            }
            if (!state.open || typeof output?.output !== 'string') return;
            state.calls += 1;
            const idle = now() - state.since;
            if (state.calls < calls && idle < ms) return;
            const minutes = Math.floor(idle / 60000);
            const span =
                state.calls >= calls
                    ? state.calls + ' tool calls'
                    : minutes + (minutes === 1 ? ' minute' : ' minutes');
            output.output +=
                '\\n\\n<system-reminder>Your todo list has not changed in ' +
                span +
                '. If you finished or started an item, update it with todowrite now. Do not mention this reminder.</system-reminder>';
            state.calls = 0;
            state.since = now();
        },
    };
};
`;
