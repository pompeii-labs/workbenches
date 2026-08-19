import { relative } from 'node:path';

import type { ResolvedWorkbench, RunnerInvocation } from './types.js';

export function buildOpenCodeInvocation(
    workbench: ResolvedWorkbench,
    task: string,
    baseEnv: Record<string, string | undefined> = process.env,
    configDirectory?: string
): RunnerInvocation {
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
    if (!task.trim()) throw new Error('task must not be empty');

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

    const config = {
        $schema: 'https://opencode.ai/config.json',
        autoupdate: false,
        share: 'disabled',
        model: workbench.manifest.model,
        instructions: [
            relative(
                workbench.repositoryDirectory,
                workbench.instructionsPath
            ),
        ],
        ...(Object.keys(mcp).length > 0 ? { mcp } : {}),
    };

    return {
        command: [
            'opencode',
            'run',
            '--pure',
            '--model',
            workbench.manifest.model,
            '--dir',
            workbench.repositoryDirectory,
            '--format',
            'json',
            task.trim(),
        ],
        cwd: workbench.repositoryDirectory,
        env: {
            ...baseEnv,
            PWD: workbench.repositoryDirectory,
            OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
            OPENCODE_DISABLE_PROJECT_CONFIG: 'true',
            ...(configDirectory
                ? { OPENCODE_CONFIG_DIR: configDirectory }
                : {}),
        },
    };
}

function environmentReferences(value: string): string[] {
    return [...value.matchAll(/\$\{([A-Z][A-Z0-9_]*)\}/g)].map(
        (match) => match[1]!
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
