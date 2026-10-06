import { join, resolve } from 'node:path';

import type { ResolvedWorkbench } from '../../types.js';
import type { RunnerContext } from '../context/files.js';
import type { RunnerContextStaging } from '../context/stage.js';
import type { RunnerFiles } from '../types.js';

/** Pi's staged config directory and context, and how to remove them. */
export class StagedPiConfig {
    constructor(
        private readonly files: RunnerFiles,
        readonly directory: string,
        readonly context: RunnerContext
    ) {}

    cleanup(): Promise<void> {
        return this.files.remove(this.directory);
    }
}

/** Stages Pi's config directory, skills, credentials link, and context through `files`. */
export class PiConfigStaging {
    constructor(
        private readonly files: RunnerFiles,
        private readonly context: RunnerContextStaging
    ) {}

    async stage(
        workbench: ResolvedWorkbench,
        environment: Record<string, string | undefined>,
        options: { linkNativeCredentials?: boolean }
    ): Promise<StagedPiConfig> {
        const files = this.files;
        const directory = await files.tempDirectory('workbench-pi-');
        let context: RunnerContext;
        try {
            if (workbench.runnerConfigPath) {
                const config = await files.lstat(workbench.runnerConfigPath);
                if (!config) {
                    throw new Error(
                        `Runner configuration does not exist: ${workbench.runnerConfigPath}`
                    );
                }
                if (config.kind !== 'directory') {
                    throw new Error('Pi runner_config must be a directory');
                }
                await files.copy(workbench.runnerConfigPath, directory);
            }
            const skillsDirectory = join(directory, 'skills');
            await files.mkdir(skillsDirectory, { recursive: true });
            await Promise.all(
                workbench.skills.map((skill) =>
                    files.copy(skill.directory, join(skillsDirectory, skill.name))
                )
            );
            const linkNativeCredentials = options.linkNativeCredentials ?? true;
            const nativeConfigDirectory = linkNativeCredentials
                ? await this.findConfigDirectory(environment)
                : undefined;
            const nativeCredentials = nativeConfigDirectory
                ? join(nativeConfigDirectory, 'auth.json')
                : undefined;
            if (nativeCredentials && (await this.isFile(nativeCredentials))) {
                await files.symlink(nativeCredentials, join(directory, 'auth.json'));
            }
            await files.mkdir(directory, { recursive: true });
            const appendPath = join(directory, 'APPEND_SYSTEM.md');
            const nativeInstructions = await files
                .readFile(appendPath)
                .then((bytes) => new TextDecoder().decode(bytes))
                .catch(() => '');
            context = await this.context.stage({
                directory,
                workbench,
                nativeInstructions,
                instructions: appendPath,
            });
        } catch (error) {
            await files.remove(directory);
            throw error;
        }
        return new StagedPiConfig(files, directory, context);
    }

    /** The user's own Pi directory named by `environment`, when it exists. */
    async findConfigDirectory(
        environment: Record<string, string | undefined>
    ): Promise<string | undefined> {
        const configured = environment.PI_CODING_AGENT_DIR?.trim();
        const home = environment.HOME?.trim();
        if (!configured && !home) return undefined;
        const candidate = configured
            ? resolve(configured)
            : join(home as string, '.pi', 'agent');
        const found = await this.files.stat(candidate).catch(() => undefined);
        return found?.kind === 'directory' ? candidate : undefined;
    }

    private async isFile(path: string): Promise<boolean> {
        const found = await this.files.stat(path).catch(() => undefined);
        return found?.kind === 'file';
    }
}
