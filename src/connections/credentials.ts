import { chmod, lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';

import type {
    RuntimeCredentialBinding,
    RuntimeCredentialFiles,
} from '../runtimes/contracts.js';

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

    /** The credential files a remote runtime syncs for `runner`, created private on first use. */
    async files(runtime: string, runner: string): Promise<HostCredentialFiles> {
        return new HostCredentialFiles((await this.prepare(runtime, runner)).directory);
    }
}

/**
 * Credential files under one host directory. Directories it creates are 0700
 * and every file it writes is 0600, replaced atomically.
 */
export class HostCredentialFiles implements RuntimeCredentialFiles {
    constructor(readonly directory: string) {}

    async read(path: string): Promise<string | undefined> {
        return readFile(this.resolve(path), 'utf8').catch((error) => {
            if (isNodeError(error) && error.code === 'ENOENT') return undefined;
            throw error;
        });
    }

    async write(path: string, contents: string): Promise<void> {
        const destination = this.resolve(path);
        let directory = this.directory;
        for (const part of relative(this.directory, dirname(destination))
            .split(sep)
            .filter(Boolean)) {
            directory = join(directory, part);
            await ensurePrivateDirectory(directory);
        }
        const temporary = `${destination}.${crypto.randomUUID()}.tmp`;
        await writeFile(temporary, contents, { mode: 0o600 });
        await rename(temporary, destination);
        await chmod(destination, 0o600);
    }

    private resolve(path: string): string {
        if (!/^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*$/.test(path)) {
            throw new Error(`Invalid credential path: ${path}`);
        }
        return join(this.directory, ...path.split('/'));
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
