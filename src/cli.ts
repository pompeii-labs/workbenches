#!/usr/bin/env bun

import { defineCommand, runMain } from 'citty';

import { addCommand } from './commands/add.js';
import { initCommand } from './commands/init.js';
import { listCommand } from './commands/list.js';
import { removeCommand } from './commands/remove.js';
import { runCommand } from './commands/run.js';
import { smokeCommand } from './commands/smoke.js';
import { validateCommand } from './commands/validate.js';

export const workbenchCommand = defineCommand({
    meta: {
        name: 'workbench',
        version: '0.0.0',
        description: 'Discover, save, verify, and run open Workbenches.',
    },
    subCommands: {
        init: initCommand,
        list: listCommand,
        validate: validateCommand,
        v: validateCommand,
        smoke: smokeCommand,
        add: addCommand,
        remove: removeCommand,
        run: runCommand,
    },
});

if (import.meta.main) {
    const defaultConsoleError = console.error;
    console.error = (value?: unknown, ...optional: unknown[]) => {
        if (value instanceof Error) {
            process.stderr.write(`error: ${value.message}\n`);
            return;
        }
        defaultConsoleError(value, ...optional);
    };
    try {
        await runMain(workbenchCommand);
    } finally {
        console.error = defaultConsoleError;
    }
}
