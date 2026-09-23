#!/usr/bin/env bun

import { defineCommand, renderUsage, runMain } from 'citty';
import pc from 'picocolors';
import packageMetadata from '../package.json' with { type: 'json' };
import { AuthoringJob } from './authoring/job.js';

import { addCommand } from './commands/add.js';
import { answerCommand } from './commands/answer.js';
import { attachCommand } from './commands/attach.js';
import { buildCommand } from './commands/build.js';
import { cleanCommand } from './commands/clean.js';
import { connectCommand } from './commands/connect.js';
import { createCommand } from './commands/create.js';
import { imageCommand } from './commands/image.js';
import { initCommand } from './commands/init.js';
import { killCommand } from './commands/kill.js';
import { listCommand } from './commands/list.js';
import { loginCommand } from './commands/login.js';
import { logoutCommand } from './commands/logout.js';
import { outcomeCommand } from './commands/outcome.js';
import { exitOnBrokenPipe } from './commands/pipe.js';
import { psCommand } from './commands/ps.js';
import { publishCommand } from './commands/publish.js';
import { removeCommand } from './commands/remove.js';
import { resumeCommand } from './commands/resume.js';
import { runCommand } from './commands/run.js';
import { sendCommand } from './commands/send.js';
import { smokeCommand } from './commands/smoke.js';
import { telemetryCommand } from './commands/telemetry.js';
import { updateCommand } from './commands/update.js';
import { upgradeCommand } from './commands/upgrade.js';
import { validateCommand } from './commands/validate.js';
import { viewCommand } from './commands/view.js';
import { waitCommand } from './commands/wait.js';
import { whoamiCommand } from './commands/whoami.js';
import { ModelCatalog } from './models/catalog.js';
import { RegistryClient } from './registry/index.js';
import { RunWorker } from './runs/index.js';
import { workbenchHome } from './storage.js';
import { assertWorkbenchTuiSupported } from './tui.js';

let bareInvocation = import.meta.main && process.argv.length === 2;

export const workbenchCommand = defineCommand({
    meta: {
        name: 'workbench',
        version: packageMetadata.version,
        description: 'Discover, save, verify, and run open Workbenches.',
    },
    subCommands: {
        init: initCommand,
        create: createCommand,
        image: imageCommand,
        list: listCommand,
        view: viewCommand,
        validate: validateCommand,
        smoke: smokeCommand,
        telemetry: telemetryCommand,
        update: updateCommand,
        upgrade: upgradeCommand,
        login: loginCommand,
        logout: logoutCommand,
        outcome: outcomeCommand,
        whoami: whoamiCommand,
        publish: publishCommand,
        ps: psCommand,
        build: buildCommand,
        clean: cleanCommand,
        connect: connectCommand,
        add: addCommand,
        remove: removeCommand,
        resume: resumeCommand,
        run: runCommand,
        attach: attachCommand,
        kill: killCommand,
        send: sendCommand,
        wait: waitCommand,
        answer: answerCommand,
    },
});

if (import.meta.main) {
    exitOnBrokenPipe(process.stdout);
    exitOnBrokenPipe(process.stderr);
    if (process.argv[2] === '__authoring') {
        const home = process.argv[3];
        const id = process.argv[4];
        if (!home || !id) process.exit(2);
        await new ModelCatalog({ home }).loadCached();
        process.exit(await new AuthoringJob(home).execute(id));
    }
    if (process.argv[2] === '__worker') {
        const home = process.argv[3];
        const id = process.argv[4];
        if (!home || !id) process.exit(2);
        await new ModelCatalog({ home }).loadCached();
        process.exit(await new RunWorker(home).executeDispatched(id));
    }
    const defaultConsoleError = console.error;
    const colors = pc.createColors(
        Boolean(process.stderr.isTTY) &&
            process.env.NO_COLOR === undefined &&
            process.env.TERM !== 'dumb'
    );
    const formatError = (message: string) =>
        colors.isColorSupported
            ? `${colors.red('✗')} ${colors.red(message)}`
            : `error: ${message}`;
    console.error = (value?: unknown, ...optional: unknown[]) => {
        if (value instanceof Error) {
            process.stderr.write(`${formatError(value.message)}\n`);
            return;
        }
        if (typeof value === 'string' && optional.length === 0) {
            process.stderr.write(
                `${formatError(value.startsWith('error: ') ? value.slice(7) : value)}\n`
            );
            return;
        }
        defaultConsoleError(value, ...optional);
    };
    try {
        const invocation = extractApiUrl(process.argv.slice(2));
        bareInvocation = invocation.args.length === 0;
        RegistryClient.configureApiUrl(invocation.apiUrl);
        const explicitHelp = invocation.args.some(
            (argument) => argument === '--help' || argument === '-h'
        );
        const headlessCreate = invocation.args.some((argument) =>
            /^(--task(?:=|$)|-t$|--task-file(?:=|$)|--stdin$|--detach$|-d$|--json$)/.test(
                argument
            )
        );
        if (
            !explicitHelp && invocation.args[0] === 'create' && !headlessCreate
        ) {
            assertWorkbenchTuiSupported();
        }
        if (usesModelCatalog(invocation.args)) {
            await new ModelCatalog({ home: workbenchHome() }).refresh();
        }
        if (bareInvocation) {
            process.stdout.write(
                `${commandUsage(await renderUsage(workbenchCommand))}\n\n`
            );
        } else {
            await runMain(workbenchCommand, {
                rawArgs: invocation.args,
                showUsage: async (command, parent) => {
                    if (!explicitHelp) return;
                    process.stdout.write(
                        `${commandUsage(await renderUsage(command, parent))}\n\n`
                    );
                },
            });
        }
    } catch (error) {
        console.error(
            error instanceof Error
                ? error
                : new Error('Workbench command failed unexpectedly')
        );
        process.exitCode = 1;
    } finally {
        console.error = defaultConsoleError;
    }
}

/** Citty renders the command summary in dim gray, which is hard to read in some terminals. */
function commandUsage(usage: string): string {
    return usage.replace(/^\x1b\[90m(.+?)\x1b\[39m/, '$1');
}

function usesModelCatalog(args: string[]): boolean {
    return new Set([
        'build',
        'create',
        'init',
        'resume',
        'run',
        'send',
        'smoke',
        'view',
    ]).has(args[0] ?? '');
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
