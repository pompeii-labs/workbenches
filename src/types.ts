import type { daytonaClasses } from './workbench/runtimes.js';

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

export type WorkbenchOs = 'linux' | 'macos' | 'windows';
export type WorkbenchArch = 'x64' | 'arm64';
export type WorkbenchDaytonaClass = (typeof daytonaClasses)[number];

/** What the execution environment must satisfy regardless of provider. */
export interface WorkbenchRequirements {
    /** Any of these operating systems. Absent means unconstrained. */
    os?: WorkbenchOs[];
    /** Any of these CPU architectures. Absent means unconstrained. */
    arch?: WorkbenchArch[];
    /** Minimum vCPUs. */
    cpu?: number;
    /** Minimum memory in GiB. */
    memory_gb?: number;
    /** Minimum disk in GiB. */
    disk_gb?: number;
    gpu: boolean;
}

/** One supported runtime provider and its provider-specific configuration. */
export interface WorkbenchRuntimeConfig {
    image?: string | WorkbenchImageBuild;
    docker?: WorkbenchDockerConfiguration;
    class?: WorkbenchDaytonaClass;
}

/** The runtime a run uses: its provider name plus the declared configuration. */
export interface SelectedRuntime extends WorkbenchRuntimeConfig {
    name: string;
}

export interface WorkbenchModelRoute {
    provider: string;
    model?: string;
}

export interface WorkbenchModelPolicy {
    id: string;
    routes?: WorkbenchModelRoute[];
}

interface WorkbenchManifestBase {
    version: string;
    name: string;
    description?: string;
    runner: string;
    instructions: string;
    skills: string[];
    tools: string[];
    mcps: WorkbenchMcp[];
    env: Record<string, WorkbenchEnvRequirement>;
    workspaces?: Record<string, WorkbenchWorkspaceRequirement>;
    /**
     * Runtimes the author supports, in declaration order. The parser always
     * sets this. Hand-built manifests may omit it and rely on the singular
     * form below.
     */
    runtimes?: Record<string, WorkbenchRuntimeConfig>;
    requirements?: WorkbenchRequirements;
    /**
     * The singular draft 0 form, kept as written when a manifest uses it.
     * Read runtimes through `declaredRuntimes` and `selectedRuntime`.
     */
    runtime?: string;
    image?: string | WorkbenchImageBuild;
    docker?: WorkbenchDockerConfiguration;
}

export type WorkbenchManifest = WorkbenchManifestBase & {
    model: WorkbenchModelPolicy;
    runner_config?: string;
} & ({ spec: 0 } | { spec: 1 });

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
    runnerConfigPath?: string;
    skills: ResolvedWorkbenchSkill[];
    manifest: WorkbenchManifest;
    /** Chosen runtime name. Defaults to the first declared runtime. */
    selectedRuntime?: string;
}

export interface RunnerInvocation {
    command: string[];
    cwd: string;
    env: Record<string, string | undefined>;
}

export interface SpawnedRunner {
    exited: Promise<number>;
    stdin?: {
        write(value: string | Uint8Array): unknown;
        flush?(): unknown;
        end?(): unknown;
    };
    stdout?: ReadableStream<Uint8Array>;
    stderr?: ReadableStream<Uint8Array>;
    kill?: () => void;
}
