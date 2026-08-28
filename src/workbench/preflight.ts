import type { ResolvedWorkbench, WorkbenchWorkspaceBinding } from '../types.js';

export interface PreflightResult {
    runner: { name: string; path: string };
    tools: Array<{ name: string; path: string }>;
    enabledMcps: string[];
    disabledMcps: string[];
    optionalEnvironment: string[];
    workspaces: WorkbenchWorkspaceBinding[];
    dockerEngine?: 'host';
}

export interface WorkbenchConfigurationPreflight {
    enabledMcps: string[];
    disabledMcps: string[];
    optionalEnvironment: string[];
}

export interface WorkbenchPreflightDependencies {
    environment?: Record<string, string | undefined>;
    findExecutable?: (name: string) => string | null;
}

export class WorkbenchPreflight {
    private readonly environment: Record<string, string | undefined>;
    private readonly findExecutable: (name: string) => string | null;

    constructor(dependencies: WorkbenchPreflightDependencies = {}) {
        this.environment = dependencies.environment ?? process.env;
        this.findExecutable = dependencies.findExecutable ?? Bun.which;
    }

    check(workbench: ResolvedWorkbench): PreflightResult {
        if (workbench.manifest.runtime !== 'local') {
            throw new Error(`Unsupported runtime: ${workbench.manifest.runtime}`);
        }
        if (workbench.manifest.image) {
            throw new Error('image is not supported with the local runtime');
        }

        const runnerPath = this.findExecutable(workbench.manifest.runner);
        if (!runnerPath) {
            throw new Error(`Runner CLI is unavailable: ${workbench.manifest.runner}`);
        }

        const tools = workbench.manifest.tools.map((name) => {
            const path = this.findExecutable(name);
            if (!path) {
                throw new Error(`Required CLI tool is unavailable: ${name}`);
            }
            return { name, path };
        });

        return {
            runner: { name: workbench.manifest.runner, path: runnerPath },
            tools,
            workspaces: [],
            ...this.checkConfiguration(workbench, this.environment),
        };
    }

    checkConfiguration(
        workbench: ResolvedWorkbench,
        environment: Record<string, string | undefined> = this.environment
    ): WorkbenchConfigurationPreflight {
        const optionalEnvironment: string[] = [];
        for (const [name, requirement] of Object.entries(workbench.manifest.env)) {
            if (environment[name]) continue;
            if (requirement.required) {
                throw new Error(`Missing required environment variable: ${name}`);
            }
            optionalEnvironment.push(name);
        }

        const enabledMcps: string[] = [];
        const disabledMcps: string[] = [];
        for (const server of workbench.manifest.mcps) {
            const references = new Set(
                Object.values(server.headers).flatMap((value) =>
                    WorkbenchPreflight.environmentReferences(value)
                )
            );
            for (const name of references) {
                if (!workbench.manifest.env[name]) {
                    throw new Error(
                        `MCP ${server.name} references undeclared environment variable: ${name}`
                    );
                }
            }
            const destination = [...references].some((name) => !environment[name])
                ? disabledMcps
                : enabledMcps;
            destination.push(server.name);
        }

        return { enabledMcps, disabledMcps, optionalEnvironment };
    }

    static environmentReferences(value: string): string[] {
        return [...value.matchAll(/\$\{([A-Z][A-Z0-9_]*)\}/g)].flatMap((match) =>
            match[1] ? [match[1]] : []
        );
    }
}
