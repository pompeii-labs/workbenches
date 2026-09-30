import { join, relative } from 'node:path';

import type { ResolvedWorkbench } from '../../types.js';
import { stageRunnerContextWith } from '../context-staging.js';
import type { RunnerFiles } from '../files.js';
import type { RunnerContextFiles } from '../runtime-context.js';

export interface StagedOpenCodeSkills {
    directory: string;
    nativeConfigFile?: string;
    context: RunnerContextFiles;
    cleanup: () => Promise<void>;
}

/** Stages OpenCode skills, native config, and context through `files`. */
export async function stageOpenCodeSkillsWith(
    files: RunnerFiles,
    workbench: ResolvedWorkbench
): Promise<StagedOpenCodeSkills> {
    const config = workbench.runnerConfigPath
        ? await files.stat(workbench.runnerConfigPath)
        : undefined;
    if (workbench.runnerConfigPath && !config) {
        throw new Error(
            `Runner configuration does not exist: ${workbench.runnerConfigPath}`
        );
    }
    const configDirectory =
        config?.kind === 'directory' ? workbench.runnerConfigPath : undefined;
    const directory = await files.tempDirectory('workbench-opencode-');
    const skillsDirectory = join(directory, 'skills');
    let context: RunnerContextFiles;
    let nativeConfigFile: string | undefined;
    try {
        if (configDirectory) {
            await files.copy(configDirectory, directory);
        }
        if (config?.kind === 'file' && workbench.runnerConfigPath) {
            // Native config loading can write schema metadata. Keep those writes
            // out of the pinned package, and preserve package-relative references.
            const native = join(directory, 'native');
            await files.copy(workbench.packageDirectory, native);
            nativeConfigFile = join(
                native,
                relative(workbench.packageDirectory, workbench.runnerConfigPath)
            );
        }
        await files.mkdir(skillsDirectory, { recursive: true });
        await Promise.all(
            workbench.skills.map((skill) =>
                files.copy(skill.directory, join(skillsDirectory, skill.name))
            )
        );
        context = await stageRunnerContextWith(files, directory, workbench);
        await files.chmod(directory, 0o555);
    } catch (error) {
        await files.remove(directory);
        throw error;
    }
    return {
        directory,
        ...(nativeConfigFile ? { nativeConfigFile } : {}),
        context,
        cleanup: async () => {
            await files.chmod(directory, 0o755).catch(() => {});
            await files.remove(directory);
        },
    };
}
