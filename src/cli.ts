#!/usr/bin/env bun

import { defineCommand, runMain } from 'citty';
import packageMetadata from '../package.json' with { type: 'json' };

import { addCommand } from './commands/add.js';
import { attachCommand } from './commands/attach.js';
import { buildCommand } from './commands/build.js';
import { initCommand } from './commands/init.js';
import { killCommand } from './commands/kill.js';
import { listCommand } from './commands/list.js';
import { removeCommand } from './commands/remove.js';
import { runCommand } from './commands/run.js';
import { smokeCommand } from './commands/smoke.js';
import { validateCommand } from './commands/validate.js';
import { viewCommand } from './commands/view.js';
import { launchWorkbenchTui } from './tui.js';
import { executeDetachedStoredRun } from './worker.js';

const bareInvocation = import.meta.main && process.argv.length === 2;

export const workbenchCommand = defineCommand({
    meta: {
        name: 'workbench',
        version: packageMetadata.version,
        description: 'Discover, save, verify, and run open Workbenches.',
    },
    async run() {
        if (bareInvocation) await launchWorkbenchTui();
    },
    subCommands: {
        init: initCommand,
        list: listCommand,
        view: viewCommand,
        validate: validateCommand,
        v: validateCommand,
        smoke: smokeCommand,
        build: buildCommand,
        add: addCommand,
        remove: removeCommand,
        run: runCommand,
        attach: attachCommand,
        kill: killCommand,
    },
});

if (import.meta.main) {
    if (process.argv[2] === '__worker') {
        const home = process.argv[3];
        const id = process.argv[4];
        if (!home || !id) process.exit(2);
        process.exit(await executeDetachedStoredRun({ home, id }));
    }
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
