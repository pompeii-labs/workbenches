import { relative } from 'node:path';

import type { ResolvedWorkbench, RunnerInvocation } from './types.js';

export function buildOpenCodeInvocation(
    workbench: ResolvedWorkbench,
    task: string,
    baseEnv: Record<string, string | undefined> = process.env,
    configDirectory?: string,
    workspaceDirectory = workbench.repositoryDirectory
): RunnerInvocation {
    if (!task.trim()) throw new Error('task must not be empty');
    const environment = buildOpenCodeEnvironment(
        workbench,
        baseEnv,
        configDirectory,
        workspaceDirectory
    );

    return {
        command: [
            'opencode',
            'run',
            '--pure',
            '--model',
            workbench.manifest.model,
            '--dir',
            workspaceDirectory,
            '--format',
            'json',
            task.trim(),
        ],
        cwd: workspaceDirectory,
        env: environment,
    };
}

export function buildOpenCodeSessionInvocation(
    workbench: ResolvedWorkbench,
    task: string,
    sessionId: string | undefined,
    baseEnv: Record<string, string | undefined> = process.env,
    configDirectory?: string,
    workspaceDirectory = workbench.repositoryDirectory
): RunnerInvocation {
    const invocation = buildOpenCodeInvocation(
        workbench,
        task,
        baseEnv,
        configDirectory,
        workspaceDirectory
    );
    if (sessionId === undefined) return invocation;
    const normalized = sessionId.trim();
    if (!normalized) throw new Error('sessionId must not be empty');
    return {
        ...invocation,
        command: [
            ...invocation.command.slice(0, -1),
            '--session',
            normalized,
            invocation.command.at(-1) as string,
        ],
    };
}

export function buildOpenCodeServerInvocation(
    workbench: ResolvedWorkbench,
    password: string,
    baseEnv: Record<string, string | undefined> = process.env,
    configDirectory?: string,
    workspaceDirectory = workbench.repositoryDirectory
): RunnerInvocation {
    if (!password) throw new Error('OpenCode server password must not be empty');
    return {
        command: [
            'opencode',
            'serve',
            '--pure',
            '--hostname',
            '127.0.0.1',
            '--port',
            '0',
        ],
        cwd: workspaceDirectory,
        env: {
            ...buildOpenCodeEnvironment(
                workbench,
                baseEnv,
                configDirectory,
                workspaceDirectory
            ),
            OPENCODE_SERVER_PASSWORD: password,
        },
    };
}

function buildOpenCodeEnvironment(
    workbench: ResolvedWorkbench,
    baseEnv: Record<string, string | undefined>,
    configDirectory: string | undefined,
    workspaceDirectory: string
): Record<string, string | undefined> {
    if (workbench.manifest.runner !== 'opencode') {
        throw new Error(`Unsupported runner: ${workbench.manifest.runner}`);
    }
    if (workbench.manifest.runtime !== 'local') {
        throw new Error(`Unsupported runtime: ${workbench.manifest.runtime}`);
    }
    if (workbench.manifest.image) {
        throw new Error('image is not supported with the local runtime');
    }
    if (workbench.skills.length > 0 && !configDirectory) {
        throw new Error('OpenCode skills require a staged config directory');
    }

    for (const [name, requirement] of Object.entries(workbench.manifest.env)) {
        if (requirement.required && !baseEnv[name]) {
            throw new Error(`Missing required environment variable: ${name}`);
        }
    }

    const mcp = Object.fromEntries(
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
            if ([...references].some((name) => !baseEnv[name])) return [];
            return [
                [
                    server.name,
                    {
                        type: 'remote',
                        url: server.url,
                        enabled: true,
                        headers: Object.fromEntries(
                            Object.entries(server.headers).map(([name, value]) => [
                                name,
                                openCodeEnvironmentReferences(value),
                            ])
                        ),
                    },
                ],
            ];
        })
    );
    const instructionRelativePath = relative(
        workspaceDirectory,
        workbench.instructionsPath
    );
    const instructionPath = instructionRelativePath.startsWith('..')
        ? workbench.instructionsPath
        : instructionRelativePath;
    const config = {
        $schema: 'https://opencode.ai/config.json',
        autoupdate: false,
        share: 'disabled',
        model: workbench.manifest.model,
        instructions: [instructionPath],
        ...(Object.keys(mcp).length > 0 ? { mcp } : {}),
    };

    return {
        ...baseEnv,
        PWD: workspaceDirectory,
        OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
        OPENCODE_DISABLE_PROJECT_CONFIG: 'true',
        ...(configDirectory ? { OPENCODE_CONFIG_DIR: configDirectory } : {}),
    };
}

function environmentReferences(value: string): string[] {
    return [...value.matchAll(/\$\{([A-Z][A-Z0-9_]*)\}/g)].flatMap((match) =>
        match[1] ? [match[1]] : []
    );
}

function openCodeEnvironmentReferences(value: string): string {
    return value.replace(
        /\$\{([A-Z][A-Z0-9_]*)\}/g,
        (_, name: string) => `{env:${name}}`
    );
}

export function publicInvocation(invocation: RunnerInvocation) {
    const config = invocation.env.OPENCODE_CONFIG_CONTENT;
    return {
        command: invocation.command,
        cwd: invocation.cwd,
        opencode_config: config ? JSON.parse(config) : null,
    };
}
