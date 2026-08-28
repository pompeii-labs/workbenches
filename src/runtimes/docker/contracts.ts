import type { SpawnedRunner } from '../../types.js';
import type { RuntimePreparation } from '../contracts.js';

export interface DockerPreparation extends RuntimePreparation {
    kind: 'image';
    reference: string;
    immutableReference: string;
    action: 'pulled' | 'built' | 'cache-hit';
}

export interface DockerCommandResult {
    code: number;
    stdout: string;
    stderr: string;
}

export interface DockerProcessOptions {
    cwd?: string;
    env?: Record<string, string | undefined>;
}

export interface DockerSpawnOptions extends DockerProcessOptions {
    stdin: 'ignore';
    stdout: 'pipe';
    stderr: 'pipe';
}

export interface DockerInteractiveSpawnOptions extends DockerProcessOptions {
    stdin: 'inherit';
    stdout: 'inherit';
    stderr: 'inherit';
}

export interface DockerUser {
    uid: number;
    gid: number;
}

export interface DockerHostSocket {
    path: string;
    gid?: number;
}

export interface DockerRuntimeDependencies {
    findExecutable?: (name: string) => string | null;
    command?: (
        command: string[],
        options?: DockerProcessOptions
    ) => Promise<DockerCommandResult>;
    spawn?: (command: string[], options: DockerSpawnOptions) => SpawnedRunner;
    interact?: (
        command: string[],
        options: DockerInteractiveSpawnOptions
    ) => Promise<number>;
    user?: () => DockerUser | undefined;
    hostSocket?: (
        docker: string,
        command: NonNullable<DockerRuntimeDependencies['command']>
    ) => Promise<DockerHostSocket>;
}

export interface DockerImageInspect {
    Id?: string;
    RepoDigests?: string[];
}
