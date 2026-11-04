import { join, resolve } from 'node:path';

import type { ResolvedWorkbench } from '../../types.js';
import type { RunnerContext } from '../context/files.js';
import type { RunnerContextStaging } from '../context/stage.js';
import { mcpServers } from '../mcp.js';
import type { RunnerFiles } from '../types.js';
import { record } from './rpc.js';

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
            await this.stageMcp(join(directory, 'mcp.json'), workbench, environment);
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

    /**
     * Adds the declared MCPs to Pi's user-level `mcp.json`, keeping any servers
     * the package's `runner_config` already defines; a declared server replaces
     * one with the same name. Direct exposure declares their tools to the model,
     * because Pi's default exposure reaches them only from `codemode`, which is
     * not a default tool.
     */
    private async stageMcp(
        path: string,
        workbench: ResolvedWorkbench,
        environment: Record<string, string | undefined>
    ): Promise<void> {
        const declared = Object.entries(mcpServers(workbench, environment));
        if (declared.length === 0) return;
        const config = (await this.isFile(path))
            ? packageMcpConfig(
                  new TextDecoder().decode(await this.files.readFile(path))
              )
            : {};
        const servers = { ...record(config.mcpServers) };
        for (const [name, { url, headers }] of declared) {
            servers[name] = {
                url,
                ...(headers ? { headers } : {}),
                exposure: 'direct',
            };
        }
        await this.files.writeFile(
            path,
            `${JSON.stringify({ ...config, mcpServers: servers }, null, 2)}\n`
        );
    }

    private async isFile(path: string): Promise<boolean> {
        const found = await this.files.stat(path).catch(() => undefined);
        return found?.kind === 'file';
    }
}

function packageMcpConfig(text: string): Record<string, unknown> {
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        throw new Error('Pi runner_config mcp.json is not valid JSON');
    }
    const config = record(parsed);
    if (!config || (config.mcpServers !== undefined && !record(config.mcpServers))) {
        throw new Error(
            'Pi runner_config mcp.json must be an object with an mcpServers object'
        );
    }
    return config;
}
