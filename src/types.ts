export interface WorkbenchEnvRequirement {
    required: boolean;
}

export interface WorkbenchMcp {
    name: string;
    transport: 'http';
    url: string;
    headers: Record<string, string>;
}

export interface WorkbenchManifest {
    version: 0;
    name: string;
    description?: string;
    runner: string;
    model: string;
    instructions: string;
    skills: string[];
    tools: string[];
    mcps: WorkbenchMcp[];
    env: Record<string, WorkbenchEnvRequirement>;
    runtime: string;
    image?: string;
}

export interface ResolvedWorkbenchSkill {
    name: string;
    directory: string;
    manifestPath: string;
}

export interface ResolvedWorkbench {
    manifestPath: string;
    packageDirectory: string;
    repositoryDirectory: string;
    instructionsPath: string;
    skills: ResolvedWorkbenchSkill[];
    manifest: WorkbenchManifest;
}

export interface RunnerInvocation {
    command: string[];
    cwd: string;
    env: Record<string, string | undefined>;
}
