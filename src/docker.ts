import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, rmSync, writeFileSync } from 'node:fs';
import {
    chmod,
    copyFile,
    cp,
    lstat,
    mkdtemp,
    readdir,
    readFile,
    readlink,
    realpath,
    rm,
    stat,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { type PreflightResult, preflightWorkbenchConfiguration } from './preflight.js';
import {
    type PreparedRuntime,
    RuntimeError,
    type RuntimePrepareRequest,
    type RuntimeProvider,
} from './runtime.js';
import type { ResolvedWorkbench, RunnerInvocation, SpawnedRunner } from './types.js';

export interface DockerPreparation {
    kind: 'image';
    reference: string;
    immutableReference: string;
    action: 'pulled' | 'built' | 'cache-hit';
    cacheKey?: string;
    excludedPaths?: string[];
}

export interface DockerCommandResult {
    code: number;
    stdout: string;
    stderr: string;
}

interface DockerProcessOptions {
    cwd?: string;
    env?: Record<string, string | undefined>;
}

interface DockerSpawnOptions extends DockerProcessOptions {
    stdin: 'ignore';
    stdout: 'pipe';
    stderr: 'pipe';
}

export interface DockerRuntimeDependencies {
    findExecutable?: (name: string) => string | null;
    command?: (
        command: string[],
        options?: DockerProcessOptions
    ) => Promise<DockerCommandResult>;
    spawn?: (command: string[], options: DockerSpawnOptions) => SpawnedRunner;
    user?: () => { uid: number; gid: number } | undefined;
}

interface DockerImageInspect {
    Id?: string;
    RepoDigests?: string[];
}

interface AssetMapping {
    hostPath: string;
    runtimePath: string;
    access: 'read-only' | 'read-write';
}

export class DockerRuntimeProvider implements RuntimeProvider {
    readonly name = 'docker';
    private readonly findExecutable: (name: string) => string | null;
    private readonly command: NonNullable<DockerRuntimeDependencies['command']>;
    private readonly spawn: NonNullable<DockerRuntimeDependencies['spawn']>;
    private readonly user: NonNullable<DockerRuntimeDependencies['user']>;

    constructor(dependencies: DockerRuntimeDependencies = {}) {
        this.findExecutable = dependencies.findExecutable ?? Bun.which;
        this.command = dependencies.command ?? defaultCommand;
        this.spawn = dependencies.spawn ?? defaultSpawn;
        this.user = dependencies.user ?? hostUser;
    }

    async prepare(request: RuntimePrepareRequest): Promise<PreparedRuntime> {
        const docker = this.findExecutable('docker');
        if (!docker) {
            throw new RuntimeError(
                this.name,
                'prepare',
                'Docker CLI is unavailable on the host'
            );
        }
        if (!request.workbench.manifest.image) {
            throw new RuntimeError(
                this.name,
                'prepare',
                'Docker runtime requires an image or local image build'
            );
        }

        const command = withoutWorkbenchEnvironment(
            this.command,
            Object.keys(request.workbench.manifest.env)
        );

        await requireDocker(
            command,
            [docker, 'version', '--format', '{{.Server.Version}}'],
            undefined,
            'Docker daemon is unavailable'
        );

        const prepared =
            typeof request.workbench.manifest.image === 'string'
                ? await preparePublishedImage(
                      docker,
                      request.workbench.manifest.image,
                      command
                  )
                : await prepareLocalImage(docker, request, command);
        try {
            const mappings = createAssetMappings(request);
            await verifyAssets(mappings);
            const stateDirectory = await mkdtemp(
                join(tmpdir(), 'workbench-docker-runtime-')
            );
            return new DockerPreparedRuntime({
                request,
                docker,
                command,
                spawn: this.spawn,
                user: this.user(),
                mappings,
                preparation: prepared.preparation,
                stateDirectory,
                cleanupPreparation: async () => {
                    await Promise.all([
                        prepared.cleanup(),
                        rm(stateDirectory, { recursive: true, force: true }),
                    ]);
                },
            });
        } catch (error) {
            await prepared.cleanup();
            throw error;
        }
    }
}

class DockerPreparedRuntime implements PreparedRuntime {
    readonly name = 'docker';
    readonly workbench: ResolvedWorkbench;
    readonly workspaceDirectory: string;
    readonly environment: Record<string, string | undefined>;
    readonly preparation: DockerPreparation;
    private readonly docker: string;
    private readonly command: NonNullable<DockerRuntimeDependencies['command']>;
    private readonly spawn: NonNullable<DockerRuntimeDependencies['spawn']>;
    private readonly user: { uid: number; gid: number } | undefined;
    private readonly mappings: AssetMapping[];
    private readonly stateDirectory: string;
    private readonly cleanupPreparation: () => Promise<void>;
    private readonly active = new Map<string, SpawnedRunner>();
    private readonly pendingRemovals = new Set<Promise<void>>();
    private readonly cleanupErrors: unknown[] = [];
    private ready = false;
    private cleaned = false;

    constructor(options: {
        request: RuntimePrepareRequest;
        docker: string;
        command: NonNullable<DockerRuntimeDependencies['command']>;
        spawn: NonNullable<DockerRuntimeDependencies['spawn']>;
        user: { uid: number; gid: number } | undefined;
        mappings: AssetMapping[];
        preparation: DockerPreparation;
        stateDirectory: string;
        cleanupPreparation: () => Promise<void>;
    }) {
        this.docker = options.docker;
        this.command = options.command;
        this.spawn = options.spawn;
        this.user = options.user;
        this.mappings = options.mappings;
        this.stateDirectory = options.stateDirectory;
        this.preparation = options.preparation;
        this.cleanupPreparation = options.cleanupPreparation;
        this.workspaceDirectory = this.pathFor(options.request.workspaceDirectory);
        this.environment = containerEnvironment(options.request);
        this.workbench = remapWorkbench(options.request.workbench, (path) =>
            this.pathFor(path)
        );
    }

    pathFor(hostPath: string): string {
        const requested = resolve(hostPath);
        const match = this.mappings
            .filter((mapping) => contains(mapping.hostPath, requested))
            .toSorted((left, right) => right.hostPath.length - left.hostPath.length)[0];
        if (!match) {
            throw new Error(`Path is not staged in Docker runtime: ${hostPath}`);
        }
        const suffix = relative(match.hostPath, requested);
        return suffix ? join(match.runtimePath, suffix) : match.runtimePath;
    }

    async preflight(): Promise<PreflightResult> {
        this.assertAvailable('preflight');
        const configuration = preflightWorkbenchConfiguration(
            this.workbench,
            this.environment
        );
        const runnerPath = await this.findInside(this.workbench.manifest.runner);
        if (!runnerPath) {
            throw new Error(
                `Runner CLI is unavailable in Docker image ${this.preparation.immutableReference}: ${this.workbench.manifest.runner}`
            );
        }
        const tools: Array<{ name: string; path: string }> = [];
        for (const name of this.workbench.manifest.tools) {
            const path = await this.findInside(name);
            if (!path) {
                throw new Error(
                    `Required CLI tool is unavailable in Docker image ${this.preparation.immutableReference}: ${name}`
                );
            }
            tools.push({ name, path });
        }
        const requiredAssets = [
            this.workbench.instructionsPath,
            ...this.workbench.skills.map((skill) => skill.manifestPath),
        ];
        for (const path of requiredAssets) {
            const result = await this.runEphemeral(
                ['/bin/sh', '-c', 'test -r "$1"', 'workbench-preflight', path],
                { network: 'none', readOnly: true }
            );
            if (result.code !== 0) {
                throw new Error(`Required runtime asset is unreadable: ${path}`);
            }
        }
        this.ready = true;
        return {
            runner: { name: this.workbench.manifest.runner, path: runnerPath },
            tools,
            ...configuration,
        };
    }

    launch(invocation: RunnerInvocation): SpawnedRunner {
        this.assertAvailable('launch');
        if (!this.ready) {
            throw new Error('Runtime preflight must succeed before launch');
        }
        const [executable, ...args] = invocation.command;
        if (!executable) throw new Error('Runner command is empty');
        const name = `workbench-${randomBytes(10).toString('hex')}`;
        const environment = definedEnvironment(invocation.env);
        const environmentFile = this.writeEnvironmentFile(environment);
        const command = [
            this.docker,
            'run',
            '--rm',
            '--init',
            '--name',
            name,
            '--network',
            'bridge',
            '--read-only',
            ...userArguments(this.user),
            ...temporaryFilesystemArguments(this.user),
            ...mountArguments(this.mappings),
            '--env-file',
            environmentFile,
            '--workdir',
            invocation.cwd,
            '--entrypoint',
            executable,
            this.preparation.immutableReference,
            ...args,
        ];
        let child: SpawnedRunner;
        try {
            child = this.spawn(command, {
                cwd: process.cwd(),
                env: dockerClientEnvironment(
                    process.env,
                    Object.keys(this.workbench.manifest.env)
                ),
                stdin: 'ignore',
                stdout: 'pipe',
                stderr: 'pipe',
            });
        } catch (error) {
            rmSync(environmentFile, { force: true });
            throw error;
        }
        const tracked: SpawnedRunner = {
            ...(child.stdout ? { stdout: child.stdout } : {}),
            ...(child.stderr ? { stderr: child.stderr } : {}),
            ...(child.kill ? { kill: () => child.kill?.() } : {}),
            exited: child.exited.finally(() => {
                this.active.delete(name);
                rmSync(environmentFile, { force: true });
            }),
        };
        this.active.set(name, tracked);
        return tracked;
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
            const [name] = active;
            this.active.delete(name);
            this.queueContainerRemoval(name);
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
            await this.cleanupPreparation();
        } catch (error) {
            this.cleanupErrors.push(error);
        }
        const failure = this.cleanupErrors[0];
        if (failure) throw failure;
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
        options: { network: 'none' | 'bridge'; readOnly: boolean }
    ): Promise<DockerCommandResult> {
        const [entrypoint, ...args] = command;
        if (!entrypoint) throw new Error('Docker command is empty');
        const environment = definedEnvironment(this.environment);
        const environmentFile = this.writeEnvironmentFile(environment);
        try {
            return await this.command(
                [
                    this.docker,
                    'run',
                    '--rm',
                    '--network',
                    options.network,
                    ...(options.readOnly ? ['--read-only'] : []),
                    ...userArguments(this.user),
                    ...temporaryFilesystemArguments(this.user),
                    ...mountArguments(this.mappings),
                    '--env-file',
                    environmentFile,
                    '--entrypoint',
                    entrypoint,
                    this.preparation.immutableReference,
                    ...args,
                ],
                { env: process.env }
            );
        } finally {
            rmSync(environmentFile, { force: true });
        }
    }

    private writeEnvironmentFile(environment: Record<string, string>): string {
        const path = join(
            this.stateDirectory,
            `environment-${randomBytes(10).toString('hex')}`
        );
        writeFileSync(path, serializeDockerEnvironment(environment), {
            mode: 0o600,
            flag: 'wx',
        });
        chmodSync(path, 0o600);
        return path;
    }

    private async removeContainer(name: string): Promise<void> {
        const result = await this.command([
            this.docker,
            'container',
            'rm',
            '--force',
            name,
        ]);
        if (result.code !== 0 && !result.stderr.includes('No such container')) {
            throw new Error(firstDiagnostic(result, 'Failed to remove container'));
        }
    }

    private queueContainerRemoval(name: string): void {
        let removal: Promise<void>;
        removal = this.removeContainer(name)
            .catch((error) => {
                this.cleanupErrors.push(error);
            })
            .finally(() => {
                this.pendingRemovals.delete(removal);
            });
        this.pendingRemovals.add(removal);
    }
}

async function preparePublishedImage(
    docker: string,
    reference: string,
    command: NonNullable<DockerRuntimeDependencies['command']>
): Promise<{ preparation: DockerPreparation; cleanup: () => Promise<void> }> {
    const pinned = reference.includes('@sha256:');
    if (pinned) {
        const cached = await inspectImage(docker, reference, command);
        if (cached) {
            return {
                preparation: {
                    kind: 'image',
                    reference,
                    immutableReference: immutableReference(reference, cached),
                    action: 'cache-hit',
                },
                cleanup: async () => {},
            };
        }
    }

    await requireDocker(
        command,
        [docker, 'image', 'pull', '--quiet', reference],
        undefined,
        `Failed to pull Docker image ${reference}`
    );
    const inspected = await inspectImage(docker, reference, command);
    if (!inspected)
        throw new Error(`Pulled Docker image could not be inspected: ${reference}`);
    return {
        preparation: {
            kind: 'image',
            reference,
            immutableReference: immutableReference(reference, inspected),
            action: 'pulled',
        },
        cleanup: async () => {},
    };
}

async function prepareLocalImage(
    docker: string,
    request: RuntimePrepareRequest,
    command: NonNullable<DockerRuntimeDependencies['command']>
): Promise<{ preparation: DockerPreparation; cleanup: () => Promise<void> }> {
    const image = request.workbench.manifest.image;
    if (!image || typeof image === 'string')
        throw new Error('Local image build is missing');
    const staged = await stageDockerBuildContext(request.workbench);
    const name = dockerName(request.workbench.manifest.name);
    const tag = `workbench-local/${name}:${staged.digest.slice(0, 24)}`;
    const cached = await inspectImage(docker, tag, command);
    if (cached) {
        return {
            preparation: {
                kind: 'image',
                reference: tag,
                immutableReference: cached.Id ?? tag,
                action: 'cache-hit',
                cacheKey: staged.digest,
                excludedPaths: staged.excludedPaths,
            },
            cleanup: staged.cleanup,
        };
    }
    try {
        await requireDocker(
            command,
            [
                docker,
                'buildx',
                'build',
                '--load',
                '--progress',
                'plain',
                '--tag',
                tag,
                '--file',
                staged.dockerfile,
                staged.context,
            ],
            { env: { ...process.env, BUILDX_METADATA_PROVENANCE: 'min' } },
            `Failed to build Docker image for ${request.workbench.manifest.name}`
        );
        const inspected = await inspectImage(docker, tag, command);
        if (!inspected?.Id)
            throw new Error(`Built Docker image could not be inspected: ${tag}`);
        return {
            preparation: {
                kind: 'image',
                reference: tag,
                immutableReference: inspected.Id,
                action: 'built',
                cacheKey: staged.digest,
                excludedPaths: staged.excludedPaths,
            },
            cleanup: staged.cleanup,
        };
    } catch (error) {
        await staged.cleanup();
        throw error;
    }
}

export async function stageDockerBuildContext(workbench: ResolvedWorkbench): Promise<{
    root: string;
    context: string;
    dockerfile: string;
    digest: string;
    excludedPaths: string[];
    cleanup: () => Promise<void>;
}> {
    const image = workbench.manifest.image;
    if (!image || typeof image === 'string') {
        throw new Error('Workbench does not declare a local image build');
    }
    const sourceContext = resolve(workbench.packageDirectory, image.context ?? '.');
    const sourceDockerfile = resolve(workbench.packageDirectory, image.build);
    const root = await mkdtemp(join(tmpdir(), 'workbench-docker-build-'));
    const context = join(root, 'context');
    const dockerfile = join(root, 'Dockerfile.workbench');
    const excludedPaths: string[] = [];
    try {
        const contextStat = await stat(sourceContext).catch(() => null);
        if (!contextStat?.isDirectory()) {
            throw new Error(
                `Docker build context does not exist: ${image.context ?? '.'}`
            );
        }
        const dockerfileStat = await stat(sourceDockerfile).catch(() => null);
        if (!dockerfileStat?.isFile()) {
            throw new Error(`Dockerfile does not exist: ${image.build}`);
        }
        const repositoryDirectory = await realpath(workbench.repositoryDirectory);
        const buildContext = await realpath(sourceContext);
        const dockerfilePath = await realpath(sourceDockerfile);
        if (!contains(repositoryDirectory, buildContext)) {
            throw new Error(
                `Docker build context resolves outside the repository: ${image.context ?? '.'}`
            );
        }
        if (!contains(repositoryDirectory, dockerfilePath)) {
            throw new Error(
                `Dockerfile resolves outside the repository: ${image.build}`
            );
        }
        await cp(buildContext, context, {
            recursive: true,
            preserveTimestamps: true,
            verbatimSymlinks: true,
            filter: async (source) => {
                const name = relative(buildContext, source);
                if (!name) return true;
                if (protectedBuildPath(name)) {
                    excludedPaths.push(name);
                    return false;
                }
                const entry = await lstat(source);
                if (entry.isSymbolicLink()) {
                    await validateBuildSymlink(buildContext, source);
                } else if (!entry.isDirectory() && !entry.isFile()) {
                    throw new Error(
                        `Unsupported file in Docker build context: ${name}`
                    );
                }
                return true;
            },
        });
        await copyFile(dockerfilePath, dockerfile);
        await chmod(dockerfile, 0o600);
        const digest = await digestBuildInputs(context, dockerfile);
        return {
            root,
            context,
            dockerfile,
            digest,
            excludedPaths: [...new Set(excludedPaths)].toSorted(),
            cleanup: () => rm(root, { recursive: true, force: true }),
        };
    } catch (error) {
        await rm(root, { recursive: true, force: true });
        throw error;
    }
}

function createAssetMappings(request: RuntimePrepareRequest): AssetMapping[] {
    const workspace = resolve(request.workspaceDirectory);
    const packageDirectory = resolve(request.workbench.packageDirectory);
    const unique = new Map<string, AssetMapping>();
    for (const asset of request.assets) {
        const hostPath = resolve(asset.path);
        let runtimePath: string;
        if (hostPath === workspace) runtimePath = '/workspace';
        else if (hostPath === packageDirectory) runtimePath = '/workbench';
        else runtimePath = `/runtime-assets/${unique.size}`;
        unique.set(hostPath, { hostPath, runtimePath, access: asset.access });
    }
    return [...unique.values()];
}

async function verifyAssets(mappings: AssetMapping[]): Promise<void> {
    for (const mapping of mappings) {
        const entry = await stat(mapping.hostPath).catch(() => null);
        if (!entry)
            throw new Error(`Runtime asset does not exist: ${mapping.hostPath}`);
        if (mapping.hostPath.includes('\n') || mapping.hostPath.includes('\r')) {
            throw new Error('Runtime asset paths must not contain newlines');
        }
        if (mapping.hostPath.includes(':')) {
            throw new Error('Runtime asset paths must not contain colons');
        }
    }
}

function remapWorkbench(
    workbench: ResolvedWorkbench,
    pathFor: (path: string) => string
): ResolvedWorkbench {
    return {
        ...workbench,
        manifestPath: pathFor(workbench.manifestPath),
        packageDirectory: pathFor(workbench.packageDirectory),
        repositoryDirectory: '/workspace',
        instructionsPath: pathFor(workbench.instructionsPath),
        skills: workbench.skills.map((skill) => ({
            ...skill,
            directory: pathFor(skill.directory),
            manifestPath: pathFor(skill.manifestPath),
        })),
    };
}

function containerEnvironment(
    request: RuntimePrepareRequest
): Record<string, string | undefined> {
    return {
        HOME: '/tmp/workbench-home',
        ...Object.fromEntries(
            Object.keys(request.workbench.manifest.env).map((name) => [
                name,
                request.environment[name],
            ])
        ),
    };
}

function mountArguments(mappings: AssetMapping[]): string[] {
    return mappings.flatMap((mapping) => [
        '--volume',
        `${mapping.hostPath}:${mapping.runtimePath}${mapping.access === 'read-only' ? ':ro' : ''}`,
    ]);
}

function userArguments(user: { uid: number; gid: number } | undefined): string[] {
    return user ? ['--user', `${user.uid}:${user.gid}`] : [];
}

function serializeDockerEnvironment(environment: Record<string, string>): string {
    return `${Object.entries(environment)
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

function temporaryFilesystemArguments(
    user: { uid: number; gid: number } | undefined
): string[] {
    const ownership = user ? `,uid=0,gid=0` : '';
    return ['--tmpfs', `/tmp:rw,nosuid,nodev,mode=1777${ownership}`];
}

function definedEnvironment(
    environment: Record<string, string | undefined>
): Record<string, string> {
    return Object.fromEntries(
        Object.entries(environment).flatMap(([name, value]) =>
            value === undefined ? [] : [[name, value]]
        )
    );
}

function dockerClientEnvironment(
    environment: Record<string, string | undefined>,
    containerEnvironmentNames: string[]
): Record<string, string | undefined> {
    const result = { ...environment };
    for (const name of containerEnvironmentNames) delete result[name];
    return result;
}

function withoutWorkbenchEnvironment(
    command: NonNullable<DockerRuntimeDependencies['command']>,
    names: string[]
): NonNullable<DockerRuntimeDependencies['command']> {
    return (args, options = {}) =>
        command(args, {
            ...options,
            env: dockerClientEnvironment(options.env ?? process.env, names),
        });
}

async function inspectImage(
    docker: string,
    reference: string,
    command: NonNullable<DockerRuntimeDependencies['command']>
): Promise<DockerImageInspect | null> {
    const result = await command([
        docker,
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

function immutableReference(reference: string, inspected: DockerImageInspect): string {
    if (reference.includes('@sha256:')) return reference;
    const digest = inspected.RepoDigests?.[0];
    if (digest) return digest;
    if (inspected.Id) return inspected.Id;
    throw new Error(`Docker image has no immutable identity: ${reference}`);
}

async function requireDocker(
    command: NonNullable<DockerRuntimeDependencies['command']>,
    args: string[],
    options: DockerProcessOptions | undefined,
    failure: string
): Promise<DockerCommandResult> {
    const result = await command(args, options);
    if (result.code !== 0) throw new Error(firstDiagnostic(result, failure));
    return result;
}

function firstDiagnostic(result: DockerCommandResult, fallback: string): string {
    const line = `${result.stderr}\n${result.stdout}`
        .split(/\r?\n/)
        .map((candidate) => candidate.trim())
        .find(Boolean);
    return line ? `${fallback}: ${line.slice(0, 500)}` : fallback;
}

async function defaultCommand(
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

function defaultSpawn(command: string[], options: DockerSpawnOptions): SpawnedRunner {
    return Bun.spawn(command, options);
}

function hostUser(): { uid: number; gid: number } | undefined {
    return typeof process.getuid === 'function' && typeof process.getgid === 'function'
        ? { uid: process.getuid(), gid: process.getgid() }
        : undefined;
}

function contains(parent: string, child: string): boolean {
    const suffix = relative(parent, child);
    return (
        suffix === '' ||
        (!suffix.startsWith(`..${sep}`) && suffix !== '..' && !isAbsolute(suffix))
    );
}

function dockerName(name: string): string {
    const normalized = name
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, '-')
        .replace(/^[._-]+|[._-]+$/g, '');
    return normalized || 'workbench';
}

function protectedBuildPath(path: string): boolean {
    const segments = path.split(sep);
    if (
        segments.some((segment) =>
            ['.git', '.hg', '.svn', '.ssh', '.aws', '.gnupg'].includes(segment)
        )
    ) {
        return true;
    }
    const name = basename(path).toLowerCase();
    if (
        name === '.env' ||
        (name.startsWith('.env.') && !['.env.example', '.env.sample'].includes(name))
    ) {
        return true;
    }
    if (
        [
            '.npmrc',
            '.netrc',
            '.pypirc',
            'id_rsa',
            'id_ed25519',
            'credentials',
            'credentials.json',
        ].includes(name)
    ) {
        return true;
    }
    return ['.pem', '.key', '.p12', '.pfx', '.kubeconfig'].some((extension) =>
        name.endsWith(extension)
    );
}

async function validateBuildSymlink(root: string, path: string): Promise<void> {
    const target = await readlink(path);
    if (isAbsolute(target)) {
        throw new Error(
            `Absolute symlink is not allowed in Docker build context: ${relative(root, path)}`
        );
    }
    const destination = resolve(dirname(path), target);
    if (!contains(root, destination)) {
        throw new Error(
            `Escaping symlink is not allowed in Docker build context: ${relative(root, path)}`
        );
    }
    await realpath(destination).catch(() => {
        throw new Error(
            `Broken symlink is not allowed in Docker build context: ${relative(root, path)}`
        );
    });
}

async function digestBuildInputs(context: string, dockerfile: string): Promise<string> {
    const hash = createHash('sha256');
    hash.update('workbench-docker-context-v0\0');
    hash.update(await readFile(dockerfile));
    await hashDirectory(hash, context, '');
    return hash.digest('hex');
}

async function hashDirectory(
    hash: ReturnType<typeof createHash>,
    directory: string,
    prefix: string
): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.toSorted((left, right) =>
        left.name.localeCompare(right.name)
    )) {
        const path = join(directory, entry.name);
        const name = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
            hash.update(`d\0${name}\0`);
            await hashDirectory(hash, path, name);
        } else if (entry.isSymbolicLink()) {
            hash.update(`l\0${name}\0${await readlink(path)}\0`);
        } else if (entry.isFile()) {
            const metadata = await stat(path);
            hash.update(`f\0${name}\0${metadata.mode & 0o777}\0`);
            hash.update(await readFile(path));
            hash.update('\0');
        }
    }
}
