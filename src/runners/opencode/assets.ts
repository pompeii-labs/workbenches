import { cp, lstat, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ResolvedWorkbench } from '../../types.js';

export async function stageOpenCodeSkills(
    workbench: ResolvedWorkbench
): Promise<{ directory: string; cleanup: () => Promise<void> } | undefined> {
    const config = workbench.runnerConfigPath
        ? await lstat(workbench.runnerConfigPath)
        : undefined;
    const configDirectory = config?.isDirectory()
        ? workbench.runnerConfigPath
        : undefined;
    if (workbench.skills.length === 0 && !configDirectory) return undefined;
    const directory = await mkdtemp(join(tmpdir(), 'workbench-opencode-'));
    const skillsDirectory = join(directory, 'skills');
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
    } catch (error) {
        await rm(directory, { recursive: true, force: true });
        throw error;
    }
    return {
        directory,
        cleanup: () => rm(directory, { recursive: true, force: true }),
    };
}
