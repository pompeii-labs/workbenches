import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';

import type { ResolvedWorkbench } from './types.js';

const MAX_ENVIRONMENT_FILE_BYTES = 1024 * 1024;

export interface EnvironmentOverrides {
    file: Record<string, string>;
    explicit: Map<string, string>;
}

export async function loadEnvironmentOverrides(options: {
    envFile?: string;
    rawArgs?: string[];
    cwd?: string;
}): Promise<EnvironmentOverrides> {
    return {
        file: options.envFile
            ? await readEnvironmentFile(options.envFile, options.cwd)
            : {},
        explicit: parseEnvironmentAssignments(options.rawArgs ?? []),
    };
}

export function bindWorkbenchEnvironment(
    workbench: ResolvedWorkbench,
    overrides: EnvironmentOverrides,
    inherited: Record<string, string | undefined> = process.env
): Record<string, string | undefined> {
    const environment = { ...inherited };
    const declared = new Set(Object.keys(workbench.manifest.env));
    for (const name of declared) {
        if (Object.hasOwn(overrides.file, name))
            environment[name] = overrides.file[name];
    }
    for (const [name, value] of overrides.explicit) {
        if (!declared.has(name)) {
            throw new Error(
                `Environment override is not declared by ${workbench.manifest.name}: ${name}`
            );
        }
        environment[name] = value;
    }
    return environment;
}

export function parseEnvironmentAssignments(rawArgs: string[]): Map<string, string> {
    const assignments = new Map<string, string>();
    for (let index = 0; index < rawArgs.length; index += 1) {
        const argument = rawArgs[index];
        if (argument === '--') break;
        let assignment: string | undefined;
        if (argument === '--env') {
            assignment = rawArgs[index + 1];
            index += 1;
        } else if (argument?.startsWith('--env=')) {
            assignment = argument.slice('--env='.length);
        } else {
            continue;
        }
        if (assignment === undefined) {
            throw new Error('--env requires NAME=value');
        }
        const separator = assignment.indexOf('=');
        const name = separator < 0 ? '' : assignment.slice(0, separator);
        if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) {
            throw new Error('--env requires an uppercase NAME=value assignment');
        }
        assignments.set(name, assignment.slice(separator + 1));
    }
    return assignments;
}

async function readEnvironmentFile(
    source: string,
    cwd = process.cwd()
): Promise<Record<string, string>> {
    const path = resolve(cwd, source);
    const details = await stat(path).catch(() => null);
    if (!details?.isFile()) throw new Error(`Environment file is unavailable: ${path}`);
    if (details.size > MAX_ENVIRONMENT_FILE_BYTES) {
        throw new Error(`Environment file exceeds 1 MiB: ${path}`);
    }
    const contents = await readFile(path, 'utf8').catch(() => null);
    if (contents === null) throw new Error(`Environment file is unreadable: ${path}`);
    try {
        return Object.fromEntries(
            Object.entries(parseEnv(contents)).flatMap(([name, value]) =>
                value === undefined ? [] : [[name, value]]
            )
        );
    } catch {
        throw new Error(`Environment file is malformed: ${path}`);
    }
}
