import type { SpawnedRunner } from '../../types.js';
import type { HostDescriber } from '../../workbench/host.js';
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
    stdin: 'ignore' | 'pipe';
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
    /** Describes the machine requirements are checked against. */
    host: HostDescriber;
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

/** What the Docker CLI wrapper needs: everything but the host description. */
export type DockerClientDependencies = Omit<DockerRuntimeDependencies, 'host'>;

export interface DockerImageInspect {
    Id?: string;
    RepoDigests?: string[];
    Config?: { User?: string };
}
