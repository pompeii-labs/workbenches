import {
    cp,
    lstat,
    mkdir,
    mkdtemp,
    readFile,
    rm,
    stat,
    symlink,
} from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import type { ResolvedWorkbench } from '../../types.js';
import { type RunnerContextFiles, stageRunnerContext } from '../context.js';

export async function stagePiConfig(
    workbench: ResolvedWorkbench,
    environment: Record<string, string | undefined> = process.env,
    options: { linkNativeCredentials?: boolean } = {}
): Promise<{
    directory: string;
    context: RunnerContextFiles;
    cleanup: () => Promise<void>;
}> {
    const directory = await mkdtemp(join(tmpdir(), 'workbench-pi-'));
    let context: RunnerContextFiles;
    try {
        if (workbench.runnerConfigPath) {
            const config = await lstat(workbench.runnerConfigPath);
            if (!config.isDirectory()) {
                throw new Error('Pi runner_config must be a directory');
            }
            await cp(workbench.runnerConfigPath, directory, {
                recursive: true,
                preserveTimestamps: true,
            });
        }
        const skillsDirectory = join(directory, 'skills');
        await mkdir(skillsDirectory, { recursive: true });
        await Promise.all(
            workbench.skills.map((skill) =>
                cp(skill.directory, join(skillsDirectory, skill.name), {
                    recursive: true,
                    preserveTimestamps: true,
                })
            )
        );
        const linkNativeCredentials = options.linkNativeCredentials ?? true;
        const nativeConfigDirectory = linkNativeCredentials
            ? await findPiConfigDirectory(environment)
            : undefined;
        const nativeCredentials = nativeConfigDirectory
            ? join(nativeConfigDirectory, 'auth.json')
            : undefined;
        if (nativeCredentials && (await fileExists(nativeCredentials))) {
            await symlink(nativeCredentials, join(directory, 'auth.json'));
        }
        await mkdir(directory, { recursive: true });
        const appendPath = join(directory, 'APPEND_SYSTEM.md');
        const nativeInstructions = await readFile(appendPath, 'utf8').catch(() => '');
        context = await stageRunnerContext(
            directory,
            workbench,
            nativeInstructions,
            appendPath
        );
    } catch (error) {
        await rm(directory, { recursive: true, force: true });
        throw error;
    }
    return {
        directory,
        context,
        cleanup: () => rm(directory, { recursive: true, force: true }),
    };
}

export async function findPiConfigDirectory(
    environment: Record<string, string | undefined> = process.env
): Promise<string | undefined> {
    const configured = environment.PI_CODING_AGENT_DIR?.trim();
    const home =
        environment.HOME?.trim() ||
        (environment === process.env ? homedir() : undefined);
    if (!configured && !home) return undefined;
    const candidate = configured
        ? resolve(configured)
        : join(home as string, '.pi', 'agent');
    return (await directoryExists(candidate)) ? candidate : undefined;
}

async function directoryExists(path: string): Promise<boolean> {
    return stat(path)
        .then((value) => value.isDirectory())
        .catch(() => false);
}

async function fileExists(path: string): Promise<boolean> {
    return stat(path)
        .then((value) => value.isFile())
        .catch(() => false);
}
