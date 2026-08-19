#!/usr/bin/env bun

import { runWorkbench } from './run.js';

function usage(): never {
    process.stderr.write(
        'Usage: workbench run <workbench-path> --task <task> [--dry-run]\n'
    );
    process.exit(2);
}

function parseArguments(args: string[]) {
    if (args[0] !== 'run' || !args[1]) usage();
    const workbenchPath = args[1];
    let task: string | undefined;
    let dryRun = false;

    for (let index = 2; index < args.length; index += 1) {
        const argument = args[index];
        if (argument === '--dry-run') {
            dryRun = true;
            continue;
        }
        if (argument === '--task') {
            task = args[index + 1];
            index += 1;
            continue;
        }
        usage();
    }

    if (!task) usage();
    return { workbenchPath, task, dryRun };
}

try {
    const code = await runWorkbench(parseArguments(process.argv.slice(2)));
    process.exitCode = code;
} catch (error) {
    process.stderr.write(
        `workbench: ${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exitCode = 1;
}
