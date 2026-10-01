import { join, relative } from 'node:path';

import type { ResolvedWorkbench } from '../../types.js';
import type { RunnerContext } from '../context/files.js';
import type { RunnerContextStaging } from '../context/stage.js';
import type { RunnerFiles } from '../types.js';

/** OpenCode's staged skills, native config, and context, and how to remove them. */
export class StagedOpenCodeSkills {
    constructor(
        private readonly files: RunnerFiles,
        readonly directory: string,
        readonly context: RunnerContext,
        readonly nativeConfigFile?: string
    ) {}

    async cleanup(): Promise<void> {
        await this.files.chmod(this.directory, 0o755).catch(() => {});
        await this.files.remove(this.directory);
    }
}

/** Stages OpenCode skills, native config, and context through `files`. */
export class OpenCodeSkillStaging {
    constructor(
        private readonly files: RunnerFiles,
        private readonly context: RunnerContextStaging
    ) {}

    async stage(workbench: ResolvedWorkbench): Promise<StagedOpenCodeSkills> {
        const files = this.files;
        const config = workbench.runnerConfigPath
            ? await files.lstat(workbench.runnerConfigPath)
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
        let context: RunnerContext;
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
            context = await this.context.stage({ directory, workbench });
            await files.chmod(directory, 0o555);
        } catch (error) {
            await files.remove(directory);
            throw error;
        }
        return new StagedOpenCodeSkills(files, directory, context, nativeConfigFile);
    }
}
