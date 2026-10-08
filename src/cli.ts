#!/usr/bin/env bun

import {
    type ArgsDef,
    type CommandDef,
    defineCommand,
    renderUsage,
    runCommand as runCitty,
    runMain,
} from 'citty';
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
import { orgCommand } from './commands/org.js';
import { outcomeCommand } from './commands/outcome.js';
import { exitOnBrokenPipe } from './commands/pipe.js';
import { psCommand } from './commands/ps.js';
import { publishCommand } from './commands/publish.js';
import { pushCommand } from './commands/push.js';
import { removeCommand } from './commands/remove.js';
import { resumeCommand } from './commands/resume.js';
import { runCommand } from './commands/run.js';
import { sendCommand } from './commands/send.js';
import { smokeCommand } from './commands/smoke.js';
import { statusCommand } from './commands/status.js';
import { unpublishCommand } from './commands/unpublish.js';
import { updateCommand } from './commands/update.js';
import { upgradeCommand } from './commands/upgrade.js';
import { validateCommand } from './commands/validate.js';
import { viewCommand } from './commands/view.js';
import { waitCommand } from './commands/wait.js';
import { whoamiCommand } from './commands/whoami.js';
import { AuthenticationRequiredError } from './connections/error.js';
import { ModelCatalog } from './models/catalog.js';
import { RegistryClient } from './registry/index.js';
import { RunWorker } from './runs/index.js';
import { workbenchHome } from './storage.js';

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
        update: updateCommand,
        upgrade: upgradeCommand,
        login: loginCommand,
        logout: logoutCommand,
        org: orgCommand,
        outcome: outcomeCommand,
        whoami: whoamiCommand,
        push: pushCommand,
        publish: publishCommand,
        unpublish: unpublishCommand,
        ps: psCommand,
        status: statusCommand,
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
        const message =
            value instanceof Error
                ? value.message
                : typeof value === 'string' && optional.length === 0
                  ? value.startsWith('error: ')
                      ? value.slice(7)
                      : value
                  : undefined;
        if (message !== undefined) {
            process.stderr.write(`${formatError(message)}\n`);
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
        if (usesModelCatalog(invocation.args)) {
            await new ModelCatalog({ home: workbenchHome() }).refresh();
        }
        const showUsage = async <T extends ArgsDef>(
            command: CommandDef<T>,
            parent?: CommandDef<T>
        ) => {
            process.stdout.write(
                `${commandUsage(await renderUsage(command, parent))}\n\n`
            );
        };
        if (bareInvocation) {
            await showUsage(workbenchCommand);
        } else if (
            explicitHelp ||
            (invocation.args.length === 1 &&
                (invocation.args[0] === '--version' || invocation.args[0] === '-v'))
        ) {
            await runMain(workbenchCommand, { rawArgs: invocation.args, showUsage });
        } else {
            // citty's runMain exits 1 for every failure, so commands run here and
            // this is the one place an error becomes an exit code.
            try {
                await runCitty(workbenchCommand, { rawArgs: invocation.args });
            } catch (error) {
                if (error instanceof AuthenticationRequiredError) {
                    console.error(error);
                    process.exit(error.exitCode);
                }
                if (error instanceof Error && error.name === 'CLIError') {
                    await showUsage(...usageTarget(workbenchCommand, invocation.args));
                    console.error(error.message);
                } else {
                    console.error(error, '\n');
                }
                process.exit(1);
            }
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

/** The command whose usage describes `args`, with its parent, as citty resolves it. */
function usageTarget(
    command: CommandDef,
    args: string[],
    parent?: CommandDef
): [CommandDef, CommandDef | undefined] {
    const subCommands = command.subCommands as Record<string, CommandDef> | undefined;
    const name = args.find((argument) => !argument.startsWith('-'));
    const subCommand = name ? subCommands?.[name] : undefined;
    return subCommand
        ? usageTarget(subCommand, args.slice(args.indexOf(name as string) + 1), command)
        : [command, parent];
}

/** Citty renders the command summary in dim gray, which is hard to read in some terminals. */
function commandUsage(usage: string): string {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: Matches intentional ANSI escape sequences.
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
