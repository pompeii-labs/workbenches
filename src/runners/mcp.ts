import type { ResolvedWorkbench } from '../types.js';

/**
 * Declared MCPs in the `mcpServers` format Claude Code and Pi share. Header
 * values keep their `${NAME}` references for the runner to expand, so no value
 * is written. An MCP whose referenced environment is unset is left out, as
 * OpenCode does.
 */
export function mcpServers(
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
