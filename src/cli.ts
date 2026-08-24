#!/usr/bin/env bun

import { defineCommand, runMain } from 'citty';
import packageMetadata from '../package.json' with { type: 'json' };

import { addCommand } from './commands/add.js';
import { attachCommand } from './commands/attach.js';
import { buildCommand } from './commands/build.js';
import { imageCommand } from './commands/image.js';
import { initCommand } from './commands/init.js';
import { killCommand } from './commands/kill.js';
import { listCommand } from './commands/list.js';
import { loginCommand } from './commands/login.js';
import { logoutCommand } from './commands/logout.js';
import { publishCommand } from './commands/publish.js';
import { removeCommand } from './commands/remove.js';
import { runCommand } from './commands/run.js';
import { smokeCommand } from './commands/smoke.js';
import { telemetryCommand } from './commands/telemetry.js';
import { updateCommand } from './commands/update.js';
import { upgradeCommand } from './commands/upgrade.js';
import { validateCommand } from './commands/validate.js';
import { viewCommand } from './commands/view.js';
import { whoamiCommand } from './commands/whoami.js';
import { setRegistryApiUrl } from './registry.js';
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
        image: imageCommand,
        list: listCommand,
        view: viewCommand,
        validate: validateCommand,
        v: validateCommand,
        smoke: smokeCommand,
        telemetry: telemetryCommand,
        update: updateCommand,
        upgrade: upgradeCommand,
        login: loginCommand,
        logout: logoutCommand,
        whoami: whoamiCommand,
        publish: publishCommand,
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
        const invocation = extractApiUrl(process.argv.slice(2));
        setRegistryApiUrl(invocation.apiUrl);
        await runMain(workbenchCommand, { rawArgs: invocation.args });
    } finally {
        console.error = defaultConsoleError;
    }
}

export function extractApiUrl(args: string[]): {
    args: string[];
    apiUrl?: string;
} {
    const remaining: string[] = [];
    let apiUrl: string | undefined;
    for (let index = 0; index < args.length; index += 1) {
        const argument = args[index];
        if (argument === '--api-url') {
            const value = args[index + 1];
            if (!value || value.startsWith('-')) {
                throw new Error('--api-url requires a value');
            }
            apiUrl = value;
            index += 1;
            continue;
        }
        if (argument?.startsWith('--api-url=')) {
            const value = argument.slice('--api-url='.length);
            if (!value) throw new Error('--api-url requires a value');
            apiUrl = value;
            continue;
        }
        if (argument) remaining.push(argument);
    }
    return apiUrl ? { args: remaining, apiUrl } : { args: remaining };
}
