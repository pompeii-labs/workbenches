import { chmod, cp, lstat, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import type { ResolvedWorkbench } from '../../types.js';
import { type RunnerContextFiles, stageRunnerContext } from '../context.js';

export async function stageOpenCodeSkills(workbench: ResolvedWorkbench): Promise<{
    directory: string;
    nativeConfigFile?: string;
    context: RunnerContextFiles;
    cleanup: () => Promise<void>;
}> {
    const config = workbench.runnerConfigPath
        ? await lstat(workbench.runnerConfigPath)
        : undefined;
    const configDirectory = config?.isDirectory()
        ? workbench.runnerConfigPath
        : undefined;
    const directory = await mkdtemp(join(tmpdir(), 'workbench-opencode-'));
    const skillsDirectory = join(directory, 'skills');
    let context: RunnerContextFiles;
    let nativeConfigFile: string | undefined;
    try {
        if (configDirectory) {
            await cp(configDirectory, directory, {
                recursive: true,
                preserveTimestamps: true,
            });
        }
        if (config?.isFile() && workbench.runnerConfigPath) {
            // Native config loading can write schema metadata. Keep those writes
            // out of the pinned package, and preserve package-relative references.
            const native = join(directory, 'native');
            await cp(workbench.packageDirectory, native, {
                recursive: true,
                preserveTimestamps: true,
            });
            nativeConfigFile = join(
                native,
                relative(workbench.packageDirectory, workbench.runnerConfigPath)
            );
        }
        await mkdir(skillsDirectory, { recursive: true });
        await Promise.all(
            workbench.skills.map((skill) =>
                cp(skill.directory, join(skillsDirectory, skill.name), {
                    recursive: true,
                    preserveTimestamps: true,
                })
            )
        );
        context = await stageRunnerContext(directory, workbench);
        await chmod(directory, 0o555);
    } catch (error) {
        await rm(directory, { recursive: true, force: true });
        throw error;
    }
    return {
        directory,
        ...(nativeConfigFile ? { nativeConfigFile } : {}),
        context,
        cleanup: async () => {
            await chmod(directory, 0o755).catch(() => {});
            await rm(directory, { recursive: true, force: true });
        },
    };
}
