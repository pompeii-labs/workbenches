import { chmod, cp, lstat, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ResolvedWorkbench } from '../../types.js';
import { type RunnerContextFiles, stageRunnerContext } from '../context.js';

export async function stageOpenCodeSkills(workbench: ResolvedWorkbench): Promise<{
    directory: string;
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
    try {
        if (configDirectory) {
            await cp(configDirectory, directory, {
                recursive: true,
                preserveTimestamps: true,
            });
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
        context,
        cleanup: async () => {
            await chmod(directory, 0o755).catch(() => {});
            await rm(directory, { recursive: true, force: true });
        },
    };
}
