import { isAbsolute, join, relative, resolve } from 'node:path';

import type { ResolvedWorkbench } from '../../types.js';
import type { RunnerContext } from '../context/files.js';
import type { RunnerContextStaging } from '../context/stage.js';
import { copyPackageTree } from '../files/package-copy.js';
import type { RunnerFiles } from '../types.js';

/** Parsed `runner_config`: `{ permissions: { allow?, deny? }, max_turns? }`. */
export interface ClaudeCodeRunnerConfig {
    permissions: {
        allow: string[];
        deny: string[];
    };
    maxTurns?: number;
}

export class StagedClaudeCodeConfig {
    constructor(
        private readonly files: RunnerFiles,
        readonly directory: string,
        readonly context: RunnerContext,
        readonly settingsFile: string,
        readonly mcpConfigFile: string,
        readonly maxTurns: number | undefined,
        readonly permissions: { allow: string[]; deny: string[] },
        readonly runtimeDirectories: string[],
        readonly warnings: string[],
        private readonly retained: boolean,
        private readonly cleanupDirectory = directory
    ) {}

    async cleanup(): Promise<void> {
        if (this.retained) {
            await removeEngineConfig(this.files, this.cleanupDirectory);
            return;
        }
        await restoreWrite(this.files, this.cleanupDirectory);
        await this.files.remove(this.cleanupDirectory);
    }

    remap(pathFor: (path: string) => string): StagedClaudeCodeConfig {
        return new StagedClaudeCodeConfig(
            this.files,
            pathFor(this.directory),
            this.context.remap(pathFor),
            pathFor(this.settingsFile),
            pathFor(this.mcpConfigFile),
            this.maxTurns,
            this.permissions,
            this.runtimeDirectories,
            this.warnings,
            this.retained,
            this.cleanupDirectory
        );
    }
}

/** Stages Claude Code's isolated settings, MCPs, skills, and system prompt. */
export class ClaudeCodeConfigStaging {
    constructor(
        private readonly files: RunnerFiles,
        private readonly context: RunnerContextStaging
    ) {}

    async stage(
        workbench: ResolvedWorkbench,
        environment: Record<string, string | undefined>,
        directory?: string,
        includeRuntimeDirectories = false,
        workspaceDirectory = workbench.repositoryDirectory,
        retained = Boolean(directory)
    ): Promise<StagedClaudeCodeConfig> {
        const target =
            directory ?? (await this.files.tempDirectory('workbench-claude-'));
        if (directory) {
            await removeEngineConfig(this.files, target);
            await this.files.mkdir(target, { recursive: true });
        }
        try {
            const config = await this.readRunnerConfig(workbench);
            const skillsDirectory = join(target, 'skills');
            await this.files.mkdir(skillsDirectory, { recursive: true });
            for (const skill of workbench.skills) {
                const staged = join(skillsDirectory, skill.name);
                const warnings = await copyPackageTree(
                    this.files,
                    skill.directory,
                    staged,
                    workbench.packageDirectory
                );
                if (warnings.length) throw new Error(warnings.join('\n'));
                await this.protect(staged);
            }
            const settingsFile = join(target, 'settings.json');
            const runtimeDirectories = includeRuntimeDirectories
                ? boundRuntimeDirectories(workbench, environment)
                : [];
            const mcpWarnings = disabledMcpWarnings(workbench, environment);
            const allow = [
                ...config.permissions.allow,
                ...enabledMcpNames(workbench, environment).map(
                    (name) => `mcp__${name}`
                ),
                ...runtimeDirectories.flatMap(({ path, access }) => [
                    `Read(${absolutePermissionPath(path)}/**)`,
                    ...(access === 'read-write'
                        ? [`Edit(${absolutePermissionPath(path)}/**)`]
                        : []),
                ]),
            ];
            await this.files.writeFile(
                settingsFile,
                `${JSON.stringify({ permissions: { allow, deny: config.permissions.deny } }, null, 2)}\n`,
                { mode: 0o444 }
            );
            const mcpConfigFile = join(target, 'mcp.json');
            await this.files.writeFile(
                mcpConfigFile,
                `${JSON.stringify({ mcpServers: enabledMcps(workbench, environment) }, null, 2)}\n`,
                { mode: 0o444 }
            );
            const repository = await repositoryInstructions(
                this.files,
                workspaceDirectory
            );
            const context = await this.context.stage({
                directory: target,
                workbench,
                nativeInstructions: repository.content,
            });
            return new StagedClaudeCodeConfig(
                this.files,
                target,
                context,
                settingsFile,
                mcpConfigFile,
                config.maxTurns,
                { allow, deny: config.permissions.deny },
                runtimeDirectories.map(({ path }) => path),
                [...repository.warnings, ...mcpWarnings],
                retained
            );
        } catch (error) {
            if (retained) {
                await removeEngineConfig(this.files, target);
            } else {
                await restoreWrite(this.files, target).catch(() => {});
                await this.files.remove(target);
            }
            throw error;
        }
    }

    private async readRunnerConfig(
        workbench: ResolvedWorkbench
    ): Promise<ClaudeCodeRunnerConfig> {
        if (!workbench.runnerConfigPath) {
            return { permissions: { allow: [], deny: [] } };
        }
        const stat = await this.files.lstat(workbench.runnerConfigPath);
        if (stat?.kind !== 'file') {
            throw new Error('Claude Code runner_config must be a JSON file');
        }
        let value: unknown;
        try {
            value = JSON.parse(
                new TextDecoder().decode(
                    await this.files.readFile(workbench.runnerConfigPath)
                )
            );
        } catch {
            throw new Error('Claude Code runner_config must contain valid JSON');
        }
        const root = record(value);
        if (!root) {
            throw new Error('Claude Code runner_config must be a JSON object');
        }
        const permissions = record(root?.permissions);
        if (root.permissions !== undefined && !permissions) {
            throw new Error(
                'Claude Code runner_config permissions must be a JSON object'
            );
        }
        const allow = stringArray(permissions?.allow, 'permissions.allow');
        const deny = stringArray(permissions?.deny, 'permissions.deny');
        const maxTurns = root?.max_turns;
        if (
            maxTurns !== undefined &&
            (typeof maxTurns !== 'number' ||
                !Number.isSafeInteger(maxTurns) ||
                maxTurns < 1)
        ) {
            throw new Error(
                'Claude Code runner_config max_turns must be a positive integer'
            );
        }
        for (const key of Object.keys(root ?? {})) {
            if (key !== 'permissions' && key !== 'max_turns') {
                throw new Error(`Claude Code runner_config has unknown field: ${key}`);
            }
        }
        for (const key of Object.keys(permissions ?? {})) {
            if (key !== 'allow' && key !== 'deny') {
                throw new Error(
                    `Claude Code runner_config permissions has unknown field: ${key}`
                );
            }
        }
        return {
            permissions: { allow, deny },
            ...(typeof maxTurns === 'number' ? { maxTurns } : {}),
        };
    }

    private async protect(path: string): Promise<void> {
        const stat = await this.files.lstat(path);
        if (!stat) return;
        if (stat.kind === 'symlink') return;
        if (stat.kind === 'directory') {
            for (const child of await this.files.list(path)) {
                await this.protect(join(path, child));
            }
            await this.files.chmod(path, 0o555);
            return;
        }
        await this.files.chmod(path, 0o444);
    }
}

async function repositoryInstructions(
    files: RunnerFiles,
    workspaceDirectory: string
): Promise<{ content: string; warnings: string[] }> {
    const sections: string[] = [];
    const warnings: string[] = [];
    const workspace = await files.realpath(workspaceDirectory).catch(() => undefined);
    if (!workspace) return { content: '', warnings };
    for (const relativeName of ['CLAUDE.md', join('.claude', 'CLAUDE.md')]) {
        const path = join(workspaceDirectory, relativeName);
        const resolved = await files.realpath(path).catch(() => undefined);
        if (!resolved) continue;
        const within = relativePath(workspace, resolved);
        if (!within) {
            warnings.push(
                `Repository instructions ${relativeName} were skipped because the resolved path is outside the workspace`
            );
            continue;
        }
        const stat = await files.stat(resolved);
        if (stat?.kind !== 'file') continue;
        if (stat.size > 64 * 1024) {
            warnings.push(
                `Repository instructions ${relativeName} were skipped because the file exceeds 64 KiB`
            );
            continue;
        }
        const bytes = await files.readFile(resolved);
        let content: string;
        try {
            content = new TextDecoder('utf-8', { fatal: true }).decode(bytes).trim();
        } catch {
            warnings.push(
                `Repository instructions ${relativeName} were skipped because the file is not UTF-8 text`
            );
            continue;
        }
        if (content.includes('\0')) {
            warnings.push(
                `Repository instructions ${relativeName} were skipped because the file is binary`
            );
            continue;
        }
        if (content) {
            sections.push(
                `<repository_instructions path="${relativeName}">\nThe following instructions were supplied by the repository, not by the Workbench engine.\n\n${neutralizeContextMarkers(content)}\n</repository_instructions>`
            );
        }
    }
    return { content: sections.join('\n\n'), warnings };
}

function relativePath(root: string, candidate: string): boolean {
    const path = relative(resolve(root), resolve(candidate));
    return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

function neutralizeContextMarkers(content: string): string {
    return content.replaceAll(
        /<(\s*\/?\s*)(workbench_|repository_instructions\b)/gi,
        '&lt;$1$2'
    );
}

async function removeEngineConfig(
    files: RunnerFiles,
    directory: string
): Promise<void> {
    for (const child of ['skills', 'settings.json', 'mcp.json', '.workbench-context']) {
        const path = join(directory, child);
        await restoreWrite(files, path).catch(() => {});
        await files.remove(path);
    }
}

async function restoreWrite(files: RunnerFiles, path: string): Promise<void> {
    const stat = await files.lstat(path);
    if (!stat) return;
    if (stat.kind === 'symlink') return;
    if (stat.kind === 'directory') {
        await files.chmod(path, 0o755);
        for (const child of await files.list(path)) {
            await restoreWrite(files, join(path, child));
        }
        return;
    }
    await files.chmod(path, 0o644);
}

function enabledMcpNames(
    workbench: ResolvedWorkbench,
    environment: Record<string, string | undefined>
): string[] {
    return Object.keys(enabledMcps(workbench, environment));
}

function boundRuntimeDirectories(
    workbench: ResolvedWorkbench,
    environment: Record<string, string | undefined>
): Array<{ path: string; access: 'read-only' | 'read-write' }> {
    const outbox = environment.WORKBENCH_OUTPUT_DIR;
    return [
        ...(outbox
            ? [{ path: outbox.replace(/\/$/, ''), access: 'read-write' as const }]
            : []),
        ...Object.entries(workbench.manifest.workspaces ?? {}).flatMap(
            ([name, requirement]) => {
                const variable = `WORKBENCH_WORKSPACE_${name.toUpperCase().replaceAll('-', '_')}`;
                const path = environment[variable];
                return path
                    ? [{ path: path.replace(/\/$/, ''), access: requirement.access }]
                    : [];
            }
        ),
    ];
}

function absolutePermissionPath(path: string): string {
    return path.startsWith('/') ? `/${path}` : path;
}

function enabledMcps(
    workbench: ResolvedWorkbench,
    environment: Record<string, string | undefined>
): Record<string, unknown> {
    return Object.fromEntries(
        workbench.manifest.mcps.flatMap((server) => {
            const names = Object.values(server.headers).flatMap(environmentReferences);
            if (
                names.some(
                    (name) =>
                        !environment[name] ||
                        name.startsWith('CLAUDE_') ||
                        name.startsWith('ANTHROPIC_')
                )
            )
                return [];
            return [
                [
                    server.name,
                    {
                        type: 'http',
                        url: server.url,
                        headers: server.headers,
                    },
                ],
            ];
        })
    );
}

function disabledMcpWarnings(
    workbench: ResolvedWorkbench,
    environment: Record<string, string | undefined>
): string[] {
    return workbench.manifest.mcps.flatMap((server) => {
        const names = Object.values(server.headers).flatMap(environmentReferences);
        return names.some(
            (name) => name.startsWith('CLAUDE_') || name.startsWith('ANTHROPIC_')
        ) && names.every((name) => Boolean(environment[name]))
            ? [
                  `MCP ${server.name} is disabled because Claude Code does not expand Claude or Anthropic environment references in MCP headers`,
              ]
            : [];
    });
}

function environmentReferences(value: string): string[] {
    return [...value.matchAll(/\$\{([A-Z][A-Z0-9_]*)\}/g)].flatMap((match) =>
        match[1] ? [match[1]] : []
    );
}

function record(value: unknown): Record<string, unknown> | undefined {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return undefined;
    }
    return Object.fromEntries(Object.entries(value));
}

function stringArray(value: unknown, field: string): string[] {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
        throw new Error(
            `Claude Code runner_config ${field} must be an array of strings`
        );
    }
    const strings = value.filter((item): item is string => typeof item === 'string');
    if (strings.some((item) => !item.trim())) {
        throw new Error(
            `Claude Code runner_config ${field} must not contain empty rules`
        );
    }
    return strings;
}
