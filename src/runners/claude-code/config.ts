import { join } from '../../platform/paths.js';

import type { ResolvedWorkbench, WorkbenchWorkspaceBinding } from '../../types.js';
import type { RunnerContext } from '../context/files.js';
import type { RunnerContextStaging } from '../context/stage.js';
import type { RunnerFiles } from '../types.js';
import {
    type RepositoryInstructionSource,
    RepositoryInstructions,
} from './instructions.js';

/** A package's validated `runner_config` for Claude Code. */
export interface ClaudeCodeRunnerConfig {
    allow: string[];
    deny: string[];
    maxTurns?: number;
}

/** What one staging of the Claude Code config directory needs. */
export interface ClaudeCodeStageRequest {
    workbench: ResolvedWorkbench;
    /** Decides which declared MCPs are enabled. Values are never written. */
    environment: Record<string, string | undefined>;
}

/** The directories outside the workspace a launch grants, as the runner sees them. */
export interface ClaudeCodeAccess {
    outbox?: string | undefined;
    workspaces?: WorkbenchWorkspaceBinding[] | undefined;
}

/** Characters that Claude Code reads as pattern syntax inside a path rule. */
const patternCharacters = /[*?[\]{}()\\!#]/;

/** Claude Code's staged config directory, its generated files, and how to remove them. */
export class StagedClaudeCodeConfig {
    /** What staging skipped, such as repository instructions it would not pass on. */
    readonly warnings: string[] = [];

    constructor(
        private readonly files: RunnerFiles,
        readonly configDirectory: string,
        readonly context: RunnerContext,
        readonly maxTurns: number | undefined,
        private readonly permissions: { allow: string[]; deny: string[] }
    ) {}

    /**
     * The `--settings` JSON for one launch: the package rules and MCP grants,
     * plus read and edit rules for the outbox and named workspaces. Their paths
     * are known only once the runtime is prepared, so they travel with the
     * launch rather than in a staged file.
     */
    settings(access: ClaudeCodeAccess = {}): { text: string; warnings: string[] } {
        const granted = accessRules(access);
        return {
            text: JSON.stringify({
                permissions: {
                    allow: unique([...this.permissions.allow, ...granted.rules]),
                    deny: this.permissions.deny,
                },
            }),
            warnings: granted.warnings,
        };
    }

    get skillsDirectory(): string {
        return join(this.configDirectory, 'skills');
    }

    get mcpConfigPath(): string {
        return join(this.configDirectory, 'mcp.json');
    }

    /** The file passed to `--append-system-prompt-file`. */
    get systemPromptPath(): string {
        return this.context.instructions;
    }

    async cleanup(): Promise<void> {
        await releaseTree(this.files, this.configDirectory);
        await this.files.remove(this.configDirectory);
    }
}

/**
 * Stages a `CLAUDE_CONFIG_DIR` through `files`: the package's permission
 * rules, MCP config, read-only skills, and the appended system prompt. The
 * person's own `~/.claude` never applies.
 */
export class ClaudeCodeConfigStaging {
    private readonly repository: RepositoryInstructions;

    constructor(
        private readonly files: RunnerFiles,
        private readonly context: RunnerContextStaging,
        source: RepositoryInstructionSource
    ) {
        this.repository = new RepositoryInstructions(source);
    }

    /** Stages a fresh config directory. */
    async stage(request: ClaudeCodeStageRequest): Promise<StagedClaudeCodeConfig> {
        const directory = await this.files.tempDirectory('workbench-claude-');
        try {
            return await this.write(directory, request);
        } catch (error) {
            await releaseTree(this.files, directory);
            await this.files.remove(directory);
            throw error;
        }
    }

    /**
     * Appends the repository's `CLAUDE.md` files to the staged system prompt.
     * `workspace` must be readable through the instruction source; files it
     * skips become the staged config's warnings.
     */
    async addRepositoryInstructions(
        staged: StagedClaudeCodeConfig,
        workspace: string
    ): Promise<void> {
        const repository = await this.repository.read(workspace);
        staged.warnings.push(...repository.warnings);
        if (repository.text) await this.append(staged.context, repository.text);
    }

    private async write(
        directory: string,
        request: ClaudeCodeStageRequest
    ): Promise<StagedClaudeCodeConfig> {
        const files = this.files;
        const { workbench } = request;
        const config = await this.runnerConfig(workbench);
        const servers = mcpServers(workbench, request.environment);
        await files.writeFile(
            join(directory, 'mcp.json'),
            `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`,
            { mode: 0o644, exclusive: true }
        );
        const skills = join(directory, 'skills');
        await files.mkdir(skills);
        for (const skill of workbench.skills) {
            await files.copy(skill.directory, join(skills, skill.name));
        }
        await sealTree(files, skills);

        const context = await this.context.stage({ directory, workbench });
        return new StagedClaudeCodeConfig(files, directory, context, config.maxTurns, {
            allow: unique([
                ...config.allow,
                ...Object.keys(servers).map((name) => `mcp__${name}`),
            ]),
            deny: unique(config.deny),
        });
    }

    /** Appends repository instructions after the package instructions in the staged context. */
    private async append(context: RunnerContext, text: string): Promise<void> {
        const files = this.files;
        const prefix = new TextDecoder().decode(await files.readFile(context.prefix));
        const content = `${prefix.trimEnd()}\n\n${text}\n`;
        await files.chmod(context.prefix, 0o644);
        await files.writeFile(context.prefix, content);
        await files.chmod(context.prefix, 0o444);
        await files.writeFile(context.instructions, content, { mode: 0o644 });
    }

    private async runnerConfig(
        workbench: ResolvedWorkbench
    ): Promise<ClaudeCodeRunnerConfig> {
        const path = workbench.runnerConfigPath;
        if (!path) return { allow: [], deny: [] };
        const found = await this.files.lstat(path);
        if (!found) throw new Error(`Runner configuration does not exist: ${path}`);
        if (found.kind !== 'file') {
            throw new Error(`Claude Code runner_config must be a JSON file: ${path}`);
        }
        return parseRunnerConfig(
            new TextDecoder().decode(await this.files.readFile(path)),
            path
        );
    }
}

/** Validates a Claude Code `runner_config`: `{ permissions: { allow, deny }, max_turns }`. */
export function parseRunnerConfig(text: string, path: string): ClaudeCodeRunnerConfig {
    const fail = (detail: string): never => {
        throw new Error(`Claude Code runner_config ${detail}: ${path}`);
    };
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        return fail('is not valid JSON');
    }
    if (!isRecord(parsed)) return fail('must be a JSON object');
    for (const key of Object.keys(parsed)) {
        if (key !== 'permissions' && key !== 'max_turns') {
            fail(`has an unknown field ${JSON.stringify(key)}`);
        }
    }
    const permissions = parsed.permissions ?? {};
    if (!isRecord(permissions)) return fail('permissions must be an object');
    for (const key of Object.keys(permissions)) {
        if (key !== 'allow' && key !== 'deny') {
            fail(`has an unknown permissions field ${JSON.stringify(key)}`);
        }
    }
    const rules = (key: 'allow' | 'deny'): string[] => {
        const value = permissions[key] ?? [];
        if (
            !Array.isArray(value) ||
            !value.every((rule) => typeof rule === 'string' && rule.trim())
        ) {
            return fail(`permissions.${key} must be an array of non-empty strings`);
        }
        return value.map((rule: string) => rule.trim());
    };
    const config: ClaudeCodeRunnerConfig = {
        allow: rules('allow'),
        deny: rules('deny'),
    };
    if (parsed.max_turns !== undefined) {
        const turns = parsed.max_turns;
        if (typeof turns !== 'number' || !Number.isInteger(turns) || turns < 1) {
            fail('max_turns must be a positive integer');
        }
        config.maxTurns = turns as number;
    }
    return config;
}

/** Read and edit rules for the outbox and each named workspace, in Claude's absolute-path syntax. */
function accessRules(request: ClaudeCodeAccess): {
    rules: string[];
    warnings: string[];
} {
    const targets = [
        ...(request.outbox
            ? [{ label: 'outbox', path: request.outbox, access: 'read-write' as const }]
            : []),
        ...(request.workspaces ?? []).map((binding) => ({
            label: `workspace ${binding.name}`,
            path: binding.path,
            access: binding.access,
        })),
    ];
    const rules: string[] = [];
    const warnings: string[] = [];
    for (const target of targets) {
        let path = target.path.replace(/[\\/]+$/, '');
        if (/^[a-z]:[\\/]/i.test(path)) {
            path = `/${path[0]?.toLowerCase()}/${path.slice(3).replaceAll('\\', '/')}`;
        }
        if (!path.startsWith('/') || patternCharacters.test(path)) {
            warnings.push(
                `No file rule granted for the ${target.label}: its path is not a plain absolute path`
            );
            continue;
        }
        // A leading double slash makes Claude read the rule as an absolute path.
        rules.push(`Read(/${path}/**)`);
        if (target.access === 'read-write') rules.push(`Edit(/${path}/**)`);
    }
    return { rules, warnings };
}

/**
 * Declared MCPs in Claude Code's `--mcp-config` format. Header values keep their
 * `${NAME}` references for Claude to expand, so no value is written. An MCP
 * whose referenced environment is unset is left out, as OpenCode does.
 */
function mcpServers(
    workbench: ResolvedWorkbench,
    environment: Record<string, string | undefined>
): Record<string, { type: 'http'; url: string; headers?: Record<string, string> }> {
    return Object.fromEntries(
        workbench.manifest.mcps.flatMap((server) => {
            const references = new Set(
                Object.values(server.headers).flatMap(environmentReferences)
            );
            for (const name of references) {
                if (!workbench.manifest.env[name]) {
                    throw new Error(
                        `MCP ${server.name} references undeclared environment variable: ${name}`
                    );
                }
            }
            if ([...references].some((name) => !environment[name])) return [];
            const headers =
                Object.keys(server.headers).length > 0 ? server.headers : undefined;
            return [
                [
                    server.name,
                    {
                        type: 'http' as const,
                        url: server.url,
                        ...(headers ? { headers } : {}),
                    },
                ],
            ];
        })
    );
}

function environmentReferences(value: string): string[] {
    return [...value.matchAll(/\$\{([A-Z][A-Z0-9_]*)\}/g)].flatMap((match) =>
        match[1] ? [match[1]] : []
    );
}

/** Makes a tree read-only. Symbolic links are never followed or changed. */
async function sealTree(files: RunnerFiles, path: string): Promise<void> {
    const found = await files.lstat(path);
    if (found?.kind === 'file') await files.chmod(path, 0o444);
    if (found?.kind !== 'directory') return;
    for (const name of await files.list(path)) await sealTree(files, join(path, name));
    await files.chmod(path, 0o555);
}

/** Restores owner write across a tree so it can be removed. Symbolic links are never followed. */
async function releaseTree(files: RunnerFiles, path: string): Promise<void> {
    const found = await files.lstat(path);
    if (found?.kind === 'file') await files.chmod(path, 0o600);
    if (found?.kind !== 'directory') return;
    await files.chmod(path, 0o700);
    for (const name of await files.list(path))
        await releaseTree(files, join(path, name));
}

function unique(values: string[]): string[] {
    return [...new Set(values)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
