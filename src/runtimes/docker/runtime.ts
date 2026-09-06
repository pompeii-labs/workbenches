import { randomBytes } from 'node:crypto';
import { chmodSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type {
    ResolvedWorkbench,
    RunnerInvocation,
    SpawnedRunner,
    WorkbenchWorkspaceBinding,
} from '../../types.js';
import {
    type PreflightResult,
    WorkbenchPreflight,
    WorkbenchWorkspaces,
} from '../../workbench/index.js';
import type {
    PreparedRuntime,
    RuntimeCommandOptions,
    RuntimePrepareRequest,
    RuntimeService,
    RuntimeServiceBinding,
    RuntimeSessionOptions,
} from '../contracts.js';
import { RuntimeError } from '../error.js';
import type { DockerClient } from './client.js';
import type {
    DockerCommandResult,
    DockerHostSocket,
    DockerPreparation,
    DockerUser,
} from './contracts.js';
import type { DockerCredentialVolume } from './credentials.js';
import type { DockerMountPlan } from './mounts.js';

export interface DockerRuntimeOptions {
    request: RuntimePrepareRequest;
    client: DockerClient;
    hostSocket?: DockerHostSocket;
    mounts: DockerMountPlan;
    credentials?: DockerCredentialVolume;
    preparation: DockerPreparation;
    stateDirectory: string;
    cleanupPreparation(): Promise<void>;
}

export class DockerRuntime implements PreparedRuntime {
    readonly name = 'docker';
    readonly workbench: ResolvedWorkbench;
    readonly workspaceDirectory: string;
    readonly environment: Record<string, string | undefined>;
    readonly workspaces: WorkbenchWorkspaceBinding[];
    readonly preparation: DockerPreparation;
    private readonly active = new Map<string, SpawnedRunner>();
    private readonly pendingRemovals = new Set<Promise<void>>();
    private readonly cleanupErrors: unknown[] = [];
    private readonly workspaceBindings = new WorkbenchWorkspaces();
    private ready = false;
    private cleaned = false;

    constructor(private readonly options: DockerRuntimeOptions) {
        this.preparation = options.preparation;
        this.workspaceDirectory = options.mounts.pathFor(
            options.request.workspaceDirectory
        );
        this.workspaces = options.request.assets.flatMap((asset) =>
            asset.workspace
                ? [
                      {
                          name: asset.workspace,
                          path: options.mounts.pathFor(asset.path),
                          access: asset.access,
                      },
                  ]
                : []
        );
        this.environment = {
            ...options.mounts.containerEnvironment(),
            ...options.credentials?.environment(),
            ...this.workspaceBindings.environment(this.workspaces),
            ...(options.hostSocket
                ? {
                      DOCKER_HOST: 'unix:///var/run/docker.sock',
                      WORKBENCH_DOCKER_ENGINE: 'host',
                  }
                : {}),
        };
        this.workbench = options.mounts.remap(options.request.workbench);
    }

    pathFor(hostPath: string): string {
        return this.options.mounts.pathFor(hostPath);
    }

    async preflight(): Promise<PreflightResult> {
        this.assertAvailable('preflight');
        const configuration = new WorkbenchPreflight({
            environment: this.environment,
        }).checkConfiguration(this.workbench);
        const names = [
            this.workbench.manifest.runner,
            ...this.workbench.manifest.tools,
            ...(this.options.hostSocket ? ['docker'] : []),
        ];
        const paths = await Promise.all(names.map((name) => this.findInside(name)));
        const runnerPath = paths[0];
        if (!runnerPath) {
            throw new Error(
                `Runner CLI is unavailable in Docker image ${this.preparation.immutableReference}: ${this.workbench.manifest.runner}`
            );
        }
        const tools = this.workbench.manifest.tools.map((name, index) => {
            const path = paths[index + 1];
            if (!path) {
                throw new Error(
                    `Required CLI tool is unavailable in Docker image ${this.preparation.immutableReference}: ${name}`
                );
            }
            return { name, path };
        });
        if (this.options.hostSocket && !paths.at(-1)) {
            throw new Error(
                `Docker CLI is unavailable in Docker image ${this.preparation.immutableReference} for the declared host engine binding`
            );
        }
        await Promise.all([
            this.preflightAssets(),
            ...(this.options.hostSocket ? [this.preflightHostDocker()] : []),
        ]);
        this.ready = true;
        return {
            runner: { name: this.workbench.manifest.runner, path: runnerPath },
            tools,
            workspaces: this.workspaces,
            ...(this.options.hostSocket ? { dockerEngine: 'host' as const } : {}),
            ...configuration,
        };
    }

    execute(
        invocation: RunnerInvocation,
        options: RuntimeCommandOptions = {}
    ): Promise<DockerCommandResult> {
        this.assertAvailable('launch');
        return this.runEphemeral(
            invocation.command,
            {
                network: options.network ?? 'none',
                readOnly: options.readOnly ?? true,
            },
            invocation.env,
            invocation.cwd
        );
    }

    async interact(invocation: RunnerInvocation): Promise<number> {
        this.assertAvailable('launch');
        const [entrypoint, ...args] = invocation.command;
        if (!entrypoint) throw new Error('Runner command is empty');
        const environmentFile = this.writeEnvironmentFile(invocation.env);
        try {
            return await this.options.client.interact(
                [
                    this.options.client.executable,
                    'run',
                    '--rm',
                    '--init',
                    '--interactive',
                    ...(process.stdin.isTTY ? ['--tty'] : []),
                    '--network',
                    'bridge',
                    '--read-only',
                    ...this.containerArguments(),
                    '--env-file',
                    environmentFile,
                    '--workdir',
                    invocation.cwd,
                    '--entrypoint',
                    entrypoint,
                    this.preparation.immutableReference,
                    ...args,
                ],
                {
                    cwd: process.cwd(),
                    env: process.env,
                    stdin: 'inherit',
                    stdout: 'inherit',
                    stderr: 'inherit',
                }
            );
        } finally {
            rmSync(environmentFile, { force: true });
        }
    }

    launch(invocation: RunnerInvocation): SpawnedRunner {
        return this.launchSession(invocation, { stdin: 'ignore' });
    }

    launchSession(
        invocation: RunnerInvocation,
        options: RuntimeSessionOptions
    ): SpawnedRunner {
        return this.launchContainer(invocation, options).process;
    }

    launchService(
        buildInvocation: (binding: RuntimeServiceBinding) => RunnerInvocation
    ): RuntimeService {
        const port = 4096;
        const launched = this.launchContainer(
            buildInvocation({ hostname: '0.0.0.0', port }),
            { stdin: 'ignore' },
            port
        );
        return {
            process: launched.process,
            resolveUrl: (reportedUrl) =>
                this.resolvePublishedUrl(launched.name, port, reportedUrl),
        };
    }

    private launchContainer(
        invocation: RunnerInvocation,
        options: RuntimeSessionOptions,
        publishedPort?: number
    ): { name: string; process: SpawnedRunner } {
        this.assertAvailable('launch');
        if (!this.ready) {
            throw new Error('Runtime preflight must succeed before launch');
        }
        const [entrypoint, ...args] = invocation.command;
        if (!entrypoint) throw new Error('Runner command is empty');
        const name = `workbench-${randomBytes(10).toString('hex')}`;
        const environmentFile = this.writeEnvironmentFile(invocation.env);
        let child: SpawnedRunner;
        try {
            child = this.options.client.spawn(
                [
                    this.options.client.executable,
                    'run',
                    '--rm',
                    '--init',
                    '--name',
                    name,
                    ...(options.stdin === 'pipe' ? ['--interactive'] : []),
                    ...(publishedPort
                        ? ['--publish', `127.0.0.1::${publishedPort}`]
                        : []),
                    '--network',
                    'bridge',
                    '--read-only',
                    ...this.containerArguments(),
                    '--env-file',
                    environmentFile,
                    '--workdir',
                    invocation.cwd,
                    '--entrypoint',
                    entrypoint,
                    this.preparation.immutableReference,
                    ...args,
                ],
                {
                    cwd: process.cwd(),
                    env: process.env,
                    stdin: options.stdin,
                    stdout: 'pipe',
                    stderr: 'pipe',
                }
            );
        } catch (error) {
            rmSync(environmentFile, { force: true });
            throw error;
        }
        const tracked: SpawnedRunner = {
            ...(child.stdin ? { stdin: child.stdin } : {}),
            ...(child.stdout ? { stdout: child.stdout } : {}),
            ...(child.stderr ? { stderr: child.stderr } : {}),
            ...(child.kill ? { kill: () => child.kill?.() } : {}),
            exited: child.exited.finally(() => {
                this.active.delete(name);
                rmSync(environmentFile, { force: true });
            }),
        };
        this.active.set(name, tracked);
        return { name, process: tracked };
    }

    cancel(process: SpawnedRunner): void {
        const active = [...this.active.entries()].find(
            ([, candidate]) => candidate === process
        );
        let failure: unknown;
        try {
            process.kill?.();
        } catch (error) {
            failure = error;
        }
        if (active) {
            this.active.delete(active[0]);
            this.queueContainerRemoval(active[0]);
        }
        if (failure) throw failure;
    }

    async cleanup(): Promise<void> {
        if (this.cleaned) return;
        this.cleaned = true;
        for (const name of this.active.keys()) this.queueContainerRemoval(name);
        this.active.clear();
        await Promise.all([...this.pendingRemovals]);
        try {
            await this.options.cleanupPreparation();
        } catch (error) {
            this.cleanupErrors.push(error);
        }
        const failure = this.cleanupErrors[0];
        if (failure) throw failure;
    }

    private async preflightHostDocker(): Promise<void> {
        const daemon = await this.runEphemeral(
            ['docker', 'version', '--format', '{{.Server.Version}}'],
            { network: 'none', readOnly: true }
        );
        if (daemon.code !== 0) {
            throw new Error(
                this.options.client.diagnostic(
                    daemon,
                    'Host Docker engine is unavailable inside the Workbench runtime'
                )
            );
        }
    }

    private async preflightAssets(): Promise<void> {
        const paths = [
            this.workbench.instructionsPath,
            ...this.workbench.skills.map((skill) => skill.manifestPath),
        ];
        const results = await Promise.all(
            paths.map(async (path) => ({
                path,
                result: await this.runEphemeral(
                    ['/bin/sh', '-c', 'test -r "$1"', 'workbench-preflight', path],
                    { network: 'none', readOnly: true }
                ),
            }))
        );
        const unreadable = results.find(({ result }) => result.code !== 0);
        if (unreadable) {
            throw new Error(`Required runtime asset is unreadable: ${unreadable.path}`);
        }
    }

    private async findInside(name: string): Promise<string | null> {
        const result = await this.runEphemeral(
            [
                '/bin/sh',
                '-c',
                'command -v "$1" 2>/dev/null',
                'workbench-preflight',
                name,
            ],
            { network: 'none', readOnly: true }
        );
        if (result.code !== 0) return null;
        return result.stdout.trim().split(/\r?\n/)[0] || null;
    }

    private async runEphemeral(
        command: string[],
        options: { network: 'none' | 'bridge'; readOnly: boolean },
        environment = this.environment,
        workdir?: string
    ): Promise<DockerCommandResult> {
        const [entrypoint, ...args] = command;
        if (!entrypoint) throw new Error('Docker command is empty');
        const environmentFile = this.writeEnvironmentFile(environment);
        try {
            return await this.options.client.run([
                this.options.client.executable,
                'run',
                '--rm',
                '--network',
                options.network,
                ...(options.readOnly ? ['--read-only'] : []),
                ...this.containerArguments(),
                '--env-file',
                environmentFile,
                ...(workdir ? ['--workdir', workdir] : []),
                '--entrypoint',
                entrypoint,
                this.preparation.immutableReference,
                ...args,
            ]);
        } finally {
            rmSync(environmentFile, { force: true });
        }
    }

    private containerArguments(): string[] {
        return [
            ...DockerRuntime.userArguments(this.options.client.user),
            ...DockerRuntime.groupArguments(this.options.hostSocket),
            ...DockerRuntime.temporaryFilesystemArguments(this.options.client.user),
            ...this.options.mounts.arguments(),
            ...(this.options.credentials?.mountArguments() ?? []),
        ];
    }

    private writeEnvironmentFile(
        environment: Record<string, string | undefined>
    ): string {
        const path = join(
            this.options.stateDirectory,
            `environment-${randomBytes(10).toString('hex')}`
        );
        writeFileSync(path, DockerRuntime.serializeEnvironment(environment), {
            mode: 0o600,
            flag: 'wx',
        });
        chmodSync(path, 0o600);
        return path;
    }

    private async removeContainer(name: string): Promise<void> {
        const result = await this.options.client.run([
            this.options.client.executable,
            'container',
            'rm',
            '--force',
            name,
        ]);
        if (
            result.stderr.includes('removal of container') &&
            result.stderr.includes('already in progress')
        ) {
            for (let attempt = 0; attempt < 80; attempt += 1) {
                const inspected = await this.options.client.run([
                    this.options.client.executable,
                    'container',
                    'inspect',
                    name,
                ]);
                if (inspected.code !== 0) return;
                await Bun.sleep(25);
            }
        }
        if (result.code !== 0 && !result.stderr.includes('No such container')) {
            throw new Error(
                this.options.client.diagnostic(result, 'Failed to remove container')
            );
        }
    }

    private async resolvePublishedUrl(
        name: string,
        containerPort: number,
        reportedUrl: string
    ): Promise<string> {
        const result = await this.options.client.require(
            [this.options.client.executable, 'port', name, `${containerPort}/tcp`],
            'Failed to resolve Docker session endpoint'
        );
        const address = result.stdout
            .split(/\r?\n/)
            .map((line) => line.trim())
            .find((line) => /^127\.0\.0\.1:\d+$/.test(line));
        if (!address) {
            throw new Error('Docker did not expose a loopback session endpoint');
        }
        const url = new URL(reportedUrl);
        const separator = address.lastIndexOf(':');
        url.hostname = address.slice(0, separator);
        url.port = address.slice(separator + 1);
        return url.toString();
    }

    private queueContainerRemoval(name: string): void {
        let removal: Promise<void>;
        removal = this.removeContainer(name)
            .catch((error) => {
                this.cleanupErrors.push(error);
            })
            .finally(() => this.pendingRemovals.delete(removal));
        this.pendingRemovals.add(removal);
    }

    private assertAvailable(phase: 'preflight' | 'launch'): void {
        if (this.cleaned) {
            throw new RuntimeError(
                this.name,
                phase,
                'Runtime has already been cleaned up'
            );
        }
    }

    private static serializeEnvironment(
        environment: Record<string, string | undefined>
    ): string {
        const defined = Object.entries(environment).flatMap(([name, value]) =>
            value === undefined ? [] : [[name, value] as const]
        );
        return `${defined
            .toSorted(([left], [right]) => left.localeCompare(right))
            .map(([name, value]) => {
                if (/[\0\r\n]/.test(value)) {
                    throw new Error(
                        `Docker environment variable contains an unsupported newline: ${name}`
                    );
                }
                return `${name}=${value}`;
            })
            .join('\n')}\n`;
    }

    private static userArguments(user: DockerUser | undefined): string[] {
        return user ? ['--user', `${user.uid}:${user.gid}`] : [];
    }

    private static groupArguments(hostSocket: DockerHostSocket | undefined): string[] {
        if (!hostSocket) return [];
        const groups = new Set([0, hostSocket.gid].filter((gid) => gid !== undefined));
        return [...groups].flatMap((gid) => ['--group-add', String(gid)]);
    }

    private static temporaryFilesystemArguments(
        user: DockerUser | undefined
    ): string[] {
        const ownership = user ? ',uid=0,gid=0' : '';
        return ['--tmpfs', `/tmp:rw,nosuid,nodev,mode=1777${ownership}`];
    }
}
