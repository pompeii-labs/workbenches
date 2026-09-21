import { chmod, lstat, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { RuntimeCredentialBinding } from '../runtimes/contracts.js';

// Native auth files for the supported harnesses. Logs, databases, and caches are session state.
export const nativeCredentialPaths = ['auth.json', 'opencode/auth.json'] as const;

export class RunnerCredentialStore {
    constructor(private readonly home: string) {}

    binding(runtime: string, runner: string): RuntimeCredentialBinding {
        const normalizedRuntime = normalizeName(runtime, 'runtime');
        const normalized = normalizeRunner(runner);
        return {
            runtime: normalizedRuntime,
            runner: normalized,
            directory: join(
                this.home,
                'runtime-credentials',
                normalizedRuntime,
                normalized
            ),
        };
    }

    async prepare(runtime: string, runner: string): Promise<RuntimeCredentialBinding> {
        const binding = this.binding(runtime, runner);
        const directories = [
            join(this.home, 'runtime-credentials'),
            join(this.home, 'runtime-credentials', binding.runtime),
            binding.directory,
        ];
        for (const directory of directories) {
            await ensurePrivateDirectory(directory);
        }
        return binding;
    }
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
    try {
        await mkdir(directory, { mode: 0o700 });
    } catch (error) {
        if (!isNodeError(error) || error.code !== 'EEXIST') throw error;
    }
    const entry = await lstat(directory);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
        throw new Error(
            `Runner credential storage must be a real directory: ${directory}`
        );
    }
    await chmod(directory, 0o700);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
    return error instanceof Error && 'code' in error;
}

function normalizeRunner(runner: string): string {
    return normalizeName(runner, 'runner credential store');
}

function normalizeName(value: string, label: string): string {
    const normalized = value.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(normalized)) {
        throw new Error(`Invalid ${label} name: ${value}`);
    }
    return normalized;
}
