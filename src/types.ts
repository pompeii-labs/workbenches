export interface WorkbenchEnvRequirement {
    required: boolean;
}

export interface WorkbenchWorkspaceRequirement {
    required: boolean;
    access: 'read-only' | 'read-write';
}

export interface WorkbenchWorkspaceBinding {
    name: string;
    path: string;
    access: 'read-only' | 'read-write';
}

export interface WorkbenchMcp {
    name: string;
    transport: 'http';
    url: string;
    headers: Record<string, string>;
}

export interface WorkbenchImageBuild {
    build: string;
    context?: string;
}

export interface WorkbenchDockerConfiguration {
    engine?: { mode: 'host' };
}

export interface WorkbenchManifest {
    spec: 0;
    version: string;
    name: string;
    description?: string;
    runner: string;
    model: string;
    instructions: string;
    skills: string[];
    tools: string[];
    mcps: WorkbenchMcp[];
    env: Record<string, WorkbenchEnvRequirement>;
    workspaces?: Record<string, WorkbenchWorkspaceRequirement>;
    runtime: string;
    image?: string | WorkbenchImageBuild;
    docker?: WorkbenchDockerConfiguration;
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

export interface SpawnedRunner {
    exited: Promise<number>;
    stdout?: ReadableStream<Uint8Array>;
    stderr?: ReadableStream<Uint8Array>;
    kill?: () => void;
}
