import { realpath, stat } from 'node:fs/promises';

import type { SpawnedRunner } from '../../types.js';
import type {
    DockerCommandResult,
    DockerHostSocket,
    DockerImageInspect,
    DockerInteractiveSpawnOptions,
    DockerProcessOptions,
    DockerRuntimeDependencies,
    DockerSpawnOptions,
    DockerUser,
} from './contracts.js';

export class DockerClient {
    readonly user: DockerUser | undefined;
    private readonly commandProcess: NonNullable<DockerRuntimeDependencies['command']>;
    private readonly spawnProcess: NonNullable<DockerRuntimeDependencies['spawn']>;
    private readonly interactProcess: NonNullable<
        DockerRuntimeDependencies['interact']
    >;
    private readonly hostSocketResolver: NonNullable<
        DockerRuntimeDependencies['hostSocket']
    >;

    constructor(
        readonly executable: string,
        dependencies: DockerRuntimeDependencies,
        private readonly protectedEnvironmentNames: string[]
    ) {
        this.commandProcess = dependencies.command ?? DockerClient.commandProcess;
        this.spawnProcess = dependencies.spawn ?? DockerClient.spawnProcess;
        this.interactProcess = dependencies.interact ?? DockerClient.interactProcess;
        this.user = (dependencies.user ?? DockerClient.hostUser)();
        this.hostSocketResolver =
            dependencies.hostSocket ?? DockerClient.resolveHostSocket;
    }

    async run(
        command: string[],
        options: DockerProcessOptions = {}
    ): Promise<DockerCommandResult> {
        return this.commandProcess(command, {
            ...options,
            env: this.environment(options.env ?? process.env),
        });
    }

    async require(
        command: string[],
        failure: string,
        options?: DockerProcessOptions
    ): Promise<DockerCommandResult> {
        const result = await this.run(command, options);
        if (result.code !== 0) {
            throw new Error(this.diagnostic(result, failure));
        }
        return result;
    }

    spawn(command: string[], options: DockerSpawnOptions): SpawnedRunner {
        return this.spawnProcess(command, {
            ...options,
            env: this.environment(options.env ?? process.env),
        });
    }

    interact(
        command: string[],
        options: DockerInteractiveSpawnOptions
    ): Promise<number> {
        return this.interactProcess(command, {
            ...options,
            env: this.environment(options.env ?? process.env),
        });
    }

    environment(
        environment: Record<string, string | undefined>
    ): Record<string, string | undefined> {
        const result = { ...environment };
        for (const name of this.protectedEnvironmentNames) delete result[name];
        return result;
    }

    async inspectImage(reference: string): Promise<DockerImageInspect | null> {
        const result = await this.run([
            this.executable,
            'image',
            'inspect',
            reference,
            '--format',
            '{{json .}}',
        ]);
        if (result.code !== 0) return null;
        try {
            return JSON.parse(result.stdout.trim()) as DockerImageInspect;
        } catch {
            throw new Error(`Docker returned invalid image metadata for ${reference}`);
        }
    }

    immutableReference(reference: string, image: DockerImageInspect): string {
        if (reference.includes('@sha256:')) return reference;
        const digest = image.RepoDigests?.[0];
        if (digest) return digest;
        if (image.Id) return image.Id;
        throw new Error(`Docker image has no immutable identity: ${reference}`);
    }

    resolveHostSocket(): Promise<DockerHostSocket> {
        return this.hostSocketResolver(this.executable, (command, options) =>
            this.run(command, options)
        );
    }

    diagnostic(result: DockerCommandResult, fallback: string): string {
        return DockerClient.formatDiagnostic(result, fallback);
    }

    private static async commandProcess(
        command: string[],
        options: DockerProcessOptions = {}
    ): Promise<DockerCommandResult> {
        const child = Bun.spawn(command, {
            ...(options.cwd ? { cwd: options.cwd } : {}),
            env: options.env ?? process.env,
            stdin: 'ignore',
            stdout: 'pipe',
            stderr: 'pipe',
        });
        const [code, stdout, stderr] = await Promise.all([
            child.exited,
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
        ]);
        return { code, stdout, stderr };
    }

    private static spawnProcess(
        command: string[],
        options: DockerSpawnOptions
    ): SpawnedRunner {
        return Bun.spawn(command, options);
    }

    private static async interactProcess(
        command: string[],
        options: DockerInteractiveSpawnOptions
    ): Promise<number> {
        return Bun.spawn(command, options).exited;
    }

    private static hostUser(): DockerUser | undefined {
        return typeof process.getuid === 'function' &&
            typeof process.getgid === 'function'
            ? { uid: process.getuid(), gid: process.getgid() }
            : undefined;
    }

    private static async resolveHostSocket(
        docker: string,
        command: NonNullable<DockerRuntimeDependencies['command']>
    ): Promise<DockerHostSocket> {
        const inspected = await command([
            docker,
            'context',
            'inspect',
            '--format',
            '{{(index .Endpoints "docker").Host}}',
        ]);
        if (inspected.code !== 0) {
            throw new Error(
                DockerClient.formatDiagnostic(
                    inspected,
                    'Failed to inspect Docker context'
                )
            );
        }
        const endpoint = inspected.stdout.trim();
        if (!endpoint.startsWith('unix://')) {
            throw new Error(
                `Host Docker engine binding requires a Unix socket context; received ${endpoint || 'an empty endpoint'}`
            );
        }
        const requested = endpoint.slice('unix://'.length);
        const path = await realpath(requested).catch(() => requested);
        const details = await stat(path).catch(() => null);
        if (!details?.isSocket()) {
            throw new Error(`Docker context socket is unavailable: ${requested}`);
        }
        return { path, gid: details.gid };
    }

    private static formatDiagnostic(
        result: DockerCommandResult,
        fallback: string
    ): string {
        const line = `${result.stderr}\n${result.stdout}`
            .split(/\r?\n/)
            .map((candidate) => candidate.trim())
            .find(Boolean);
        return line ? `${fallback}: ${line.slice(0, 500)}` : fallback;
    }
}
