import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

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
    RuntimeInfrastructureMetadata,
    RuntimePreparation,
    RuntimePrepareRequest,
    RuntimeService,
    RuntimeServiceBinding,
    RuntimeSessionOptions,
} from '../contracts.js';
import { RuntimeError } from '../error.js';
import type { E2BClient, E2BCommand, E2BSandbox } from './contracts.js';
import { e2bPricingSource, estimateE2BCost, formatBytes } from './infrastructure.js';
import type { E2BPathPlan } from './paths.js';
import { e2bMetadata } from './sdk.js';
import { definedEnvironment, gitExcludePattern, quote, shellCommand } from './shell.js';
import { E2BAssetSnapshot } from './snapshot.js';
import { downloadE2BFile } from './streams.js';
import { terminalDimensions } from './terminal.js';

interface E2BRuntimeOptions {
    request: RuntimePrepareRequest;
    client: E2BClient;
    paths: E2BPathPlan;
    preparation: RuntimePreparation & {
        kind: 'image';
        reference: string;
        immutableReference: string;
        action: 'built' | 'cache-hit';
    };
    run: { id: string; scope: string };
    maximumTransferBytes: number;
    leaseMilliseconds: number;
    now(): Date;
    cleanupPreparation(): Promise<void>;
}

interface ActiveProcess {
    command: Promise<E2BCommand>;
    process: SpawnedRunner;
}

export class E2BRuntime implements PreparedRuntime {
    readonly name = 'e2b';
    readonly nativeAuthentication: 'persistent' | 'unavailable';
    readonly workbench: ResolvedWorkbench;
    readonly workspaceDirectory: string;
    readonly environment: Record<string, string | undefined>;
    readonly workspaces: WorkbenchWorkspaceBinding[];
    readonly preparation: E2BRuntimeOptions['preparation'];
    private readonly active = new Set<ActiveProcess>();
    private readonly workspaceBindings = new WorkbenchWorkspaces();
    private sandbox: E2BSandbox | undefined;
    private snapshots: E2BAssetSnapshot[] = [];
    private readonly snapshotBaselines = new Map<number, string>();
    private ready = false;
    private cleaned = false;
    private synchronizationAttempted = false;
    private sandboxStartedAt: number | undefined;
    private finalInfrastructure: RuntimeInfrastructureMetadata | undefined;

    constructor(private readonly options: E2BRuntimeOptions) {
        this.nativeAuthentication = options.request.credentials
            ? 'persistent'
            : 'unavailable';
        this.preparation = options.preparation;
        this.workspaceDirectory = options.paths.pathFor(
            options.request.workspaceDirectory
        );
        this.workspaces = options.request.assets.flatMap((asset) =>
            asset.workspace
                ? [
                      {
                          name: asset.workspace,
                          path: options.paths.pathFor(asset.path),
                          access: asset.access,
                      },
                  ]
                : []
        );
        this.environment = {
            ...options.paths.environment(),
            ...this.workspaceBindings.environment(this.workspaces),
        };
        this.workbench = options.paths.remap(options.request.workbench);
    }

    pathFor(hostPath: string): string {
        return this.options.paths.pathFor(hostPath);
    }

    async preflight(): Promise<PreflightResult> {
        this.assertAvailable('preflight');
        const sandbox = await this.ensureSandbox();
        const configuration = new WorkbenchPreflight({
            environment: this.environment,
        }).checkConfiguration(this.workbench);
        const names = [
            'git',
            'tar',
            this.workbench.manifest.runner,
            ...this.workbench.manifest.tools,
        ];
        const paths = await Promise.all(
            names.map((name) => this.findInside(sandbox, name))
        );
        if (!paths[0]) {
            throw new Error(
                `Git is unavailable in E2B image ${this.preparation.immutableReference}; E2B workspace synchronization requires git`
            );
        }
        if (!paths[1]) {
            throw new Error(
                `Tar is unavailable in E2B image ${this.preparation.immutableReference}; E2B workspace synchronization requires tar`
            );
        }
        const tarCapabilities = await sandbox.run('tar --help 2>&1');
        if (
            tarCapabilities.code !== 0 ||
            !`${tarCapabilities.stdout}\n${tarCapabilities.stderr}`.includes('--null')
        ) {
            throw new Error(
                `GNU tar is unavailable in E2B image ${this.preparation.immutableReference}; E2B workspace synchronization requires tar --null support`
            );
        }
        const runnerPath = paths[2];
        if (!runnerPath) {
            throw new Error(
                `Runner CLI is unavailable in E2B image ${this.preparation.immutableReference}: ${this.workbench.manifest.runner}`
            );
        }
        const tools = this.workbench.manifest.tools.map((name, index) => {
            const path = paths[index + 3];
            if (!path) {
                throw new Error(
                    `Required CLI tool is unavailable in E2B image ${this.preparation.immutableReference}: ${name}`
                );
            }
            return { name, path };
        });
        await this.preflightAssets(sandbox);
        this.ready = true;
        return {
            runner: { name: this.workbench.manifest.runner, path: runnerPath },
            tools,
            workspaces: this.workspaces,
            ...configuration,
        };
    }

    async execute(
        invocation: RunnerInvocation,
        _options: RuntimeCommandOptions = {}
    ): Promise<{ code: number; stdout: string; stderr: string }> {
        const sandbox = this.requireReady();
        return sandbox.run(shellCommand(invocation.command), {
            cwd: invocation.cwd,
            env: definedEnvironment(invocation.env),
        });
    }

    async interact(invocation: RunnerInvocation): Promise<number> {
        const sandbox = this.requireReady();
        const dimensions = terminalDimensions();
        const terminal = await sandbox.startPty(shellCommand(invocation.command), {
            cwd: invocation.cwd,
            env: definedEnvironment(invocation.env),
            columns: dimensions.columns,
            rows: dimensions.rows,
            onData: (data) => {
                globalThis.process.stdout.write(data);
            },
        });
        const input = globalThis.process.stdin;
        const output = globalThis.process.stdout;
        const previousRawMode = input.isTTY ? input.isRaw : undefined;
        const wasFlowing = input.readableFlowing;
        const onInput = (value: Buffer) => {
            void terminal.sendInput(value).catch(() => {});
        };
        const onResize = () => {
            const next = terminalDimensions();
            void terminal.resize(next.columns, next.rows).catch(() => {});
        };
        if (input.isTTY) input.setRawMode(true);
        input.on('data', onInput);
        output.on('resize', onResize);
        input.resume();
        try {
            return (await terminal.wait()).code;
        } catch (error) {
            await terminal.kill().catch(() => {});
            throw error;
        } finally {
            input.off('data', onInput);
            output.off('resize', onResize);
            if (input.isTTY) input.setRawMode(previousRawMode ?? false);
            if (wasFlowing !== true) input.pause();
        }
    }

    launch(invocation: RunnerInvocation): SpawnedRunner {
        return this.launchSession(invocation, { stdin: 'ignore' });
    }

    launchSession(
        invocation: RunnerInvocation,
        options: RuntimeSessionOptions
    ): SpawnedRunner {
        const sandbox = this.requireReady();
        let stdoutController: ReadableStreamDefaultController<Uint8Array>;
        let stderrController: ReadableStreamDefaultController<Uint8Array>;
        const stdout = new ReadableStream<Uint8Array>({
            start: (controller) => {
                stdoutController = controller;
            },
        });
        const stderr = new ReadableStream<Uint8Array>({
            start: (controller) => {
                stderrController = controller;
            },
        });
        const encoder = new TextEncoder();
        let streamedStdout = false;
        let streamedStderr = false;
        let stdoutOpen = true;
        let stderrOpen = true;
        const enqueueStdout = (data: string) => {
            if (!stdoutOpen) return;
            try {
                stdoutController.enqueue(encoder.encode(data));
            } catch {
                stdoutOpen = false;
            }
        };
        const enqueueStderr = (data: string) => {
            if (!stderrOpen) return;
            try {
                stderrController.enqueue(encoder.encode(data));
            } catch {
                stderrOpen = false;
            }
        };
        const command = sandbox.start(shellCommand(invocation.command), {
            cwd: invocation.cwd,
            env: definedEnvironment(invocation.env),
            stdin: options.stdin === 'pipe',
            onStdout: (data) => {
                streamedStdout = true;
                enqueueStdout(data);
            },
            onStderr: (data) => {
                streamedStderr = true;
                enqueueStderr(data);
            },
        });
        let active: ActiveProcess;
        const closeOutputs = () => {
            if (stdoutOpen) {
                stdoutOpen = false;
                try {
                    stdoutController.close();
                } catch {}
            }
            if (stderrOpen) {
                stderrOpen = false;
                try {
                    stderrController.close();
                } catch {}
            }
        };
        const exited = command
            .then((handle) => handle.wait())
            .then((result) => {
                if (!streamedStdout && result.stdout) {
                    enqueueStdout(result.stdout);
                }
                if (!streamedStderr && result.stderr) {
                    enqueueStderr(result.stderr);
                }
                return result.code;
            })
            .finally(() => {
                this.active.delete(active);
                closeOutputs();
            });
        const process: SpawnedRunner = {
            stdout,
            stderr,
            exited,
            ...(options.stdin === 'pipe'
                ? {
                      stdin: {
                          write: (value: string | Uint8Array) =>
                              command.then((handle) => handle.sendStdin(value)),
                          flush: () => Promise.resolve(),
                          end: () => command.then((handle) => handle.closeStdin()),
                      },
                  }
                : {}),
            kill: () => {
                void command.then((handle) => handle.kill()).catch(() => {});
            },
        };
        active = { command, process };
        this.active.add(active);
        return process;
    }

    launchService(
        buildInvocation: (binding: RuntimeServiceBinding) => RunnerInvocation
    ): RuntimeService {
        const port = 4096;
        const process = this.launch(buildInvocation({ hostname: '0.0.0.0', port }));
        return {
            process,
            resolveUrl: async (reportedUrl) => {
                const sandbox = this.requireReady();
                const url = new URL(reportedUrl);
                url.protocol = 'https:';
                url.hostname = sandbox.host(port).replace(/^https?:\/\//, '');
                url.port = '';
                return url.toString();
            },
        };
    }

    cancel(process: SpawnedRunner): void {
        const active = [...this.active].find(
            (candidate) => candidate.process === process
        );
        process.kill?.();
        if (active) this.active.delete(active);
    }

    async infrastructure(): Promise<RuntimeInfrastructureMetadata> {
        if (this.finalInfrastructure) return this.finalInfrastructure;
        return this.measureInfrastructure();
    }

    async synchronize(): Promise<void> {
        if (this.synchronizationAttempted || !this.sandbox) return;
        this.synchronizationAttempted = true;
        await this.synchronizeSnapshots(this.sandbox);
    }

    async cleanup(): Promise<void> {
        if (this.cleaned) return;
        this.cleaned = true;
        for (const active of this.active) {
            await active.command.then((command) => command.kill()).catch(() => {});
        }
        this.active.clear();
        const failures: unknown[] = [];
        if (!this.synchronizationAttempted && this.sandbox) {
            await this.synchronize().catch((error) => failures.push(error));
        }
        if (this.sandbox) {
            this.finalInfrastructure = await this.measureInfrastructure();
        }
        await this.sandbox?.kill().catch((error) => failures.push(error));
        const snapshotCleanup = await Promise.allSettled(
            this.snapshots.map((snapshot) => snapshot.cleanup())
        );
        for (const result of snapshotCleanup) {
            if (result.status === 'rejected') failures.push(result.reason);
        }
        await this.options.cleanupPreparation().catch((error) => failures.push(error));
        if (failures[0]) throw failures[0];
    }

    private async ensureSandbox(): Promise<E2BSandbox> {
        if (this.sandbox) return this.sandbox;
        const snapshots: E2BAssetSnapshot[] = [];
        let transferred = 0;
        try {
            for (const binding of this.options.paths.bindings) {
                const snapshot = await E2BAssetSnapshot.create(
                    binding,
                    this.options.maximumTransferBytes - transferred
                );
                transferred += snapshot.bytes;
                snapshots.push(snapshot);
            }
            const sandbox = await this.options.client.createSandbox({
                template: this.preparation.immutableReference,
                metadata: e2bMetadata(this.options.run),
                timeoutMilliseconds: this.options.leaseMilliseconds,
            });
            this.sandbox = sandbox;
            this.sandboxStartedAt = this.options.now().getTime();
            this.snapshots = snapshots;
            await this.stageSnapshots(sandbox, snapshots);
            return sandbox;
        } catch (error) {
            await this.sandbox?.kill().catch(() => {});
            this.sandbox = undefined;
            this.sandboxStartedAt = undefined;
            await Promise.allSettled(snapshots.map((snapshot) => snapshot.cleanup()));
            this.snapshots = [];
            this.snapshotBaselines.clear();
            throw error;
        }
    }

    private async stageSnapshots(
        sandbox: E2BSandbox,
        snapshots: E2BAssetSnapshot[]
    ): Promise<void> {
        const home = this.environment.HOME ?? '/tmp/workbench-home';
        const createdHome = await sandbox.run(`mkdir -p ${quote(home)}`);
        requireSuccess(createdHome, 'Failed to create the E2B runtime home');
        for (const [index, snapshot] of snapshots.entries()) {
            const remoteArchive = `/tmp/workbench-input-${index}.tar.gz`;
            await sandbox.upload(remoteArchive, Bun.file(snapshot.archive).stream());
            const target = snapshot.binding.runtimePath;
            const command = snapshot.sourceIsDirectory
                ? [
                      `mkdir -p ${quote(target)}`,
                      `tar -xzf ${quote(remoteArchive)} -C ${quote(target)}`,
                  ]
                : [
                      `mkdir -p ${quote(dirname(target))}`,
                      `rm -f ${quote(target)}`,
                      `tar -xzf ${quote(remoteArchive)} -C /tmp`,
                      `mv /tmp/.workbench-file ${quote(target)}`,
                  ];
            if (
                snapshot.binding.access === 'read-write' &&
                snapshot.sourceIsDirectory
            ) {
                command.push(
                    `git -C ${quote(target)} init -q`,
                    `git -C ${quote(target)} config user.email workbench@localhost`,
                    `git -C ${quote(target)} config user.name Workbench`,
                    `printf '%s\\n' ${[
                        ...remoteExclusions,
                        ...snapshot.syncExcludedPaths.map(gitExcludePattern),
                    ]
                        .map(quote)
                        .join(' ')} >> ${quote(`${target}/.git/info/exclude`)}`,
                    `git -C ${quote(target)} add -A`,
                    `git -C ${quote(target)} commit -q --allow-empty --no-gpg-sign -m baseline`,
                    `git -C ${quote(target)} rev-parse HEAD`
                );
            } else if (snapshot.binding.access === 'read-only') {
                command.push(`chmod -R a-w ${quote(target)}`);
            }
            command.push(`rm -f ${quote(remoteArchive)}`);
            const result = await sandbox.run(command.join(' && '));
            requireSuccess(
                result,
                `Failed to stage E2B runtime asset: ${snapshot.binding.hostPath}`
            );
            if (
                snapshot.binding.access === 'read-write' &&
                snapshot.sourceIsDirectory
            ) {
                const baseline = result.stdout.trim().split(/\s+/).at(-1) ?? '';
                if (!/^[a-f0-9]{40,64}$/.test(baseline)) {
                    throw new Error(
                        `Failed to record the E2B workspace baseline: ${snapshot.binding.hostPath}`
                    );
                }
                this.snapshotBaselines.set(index, baseline);
            }
        }
    }

    private async synchronizeSnapshots(sandbox: E2BSandbox): Promise<void> {
        const directory = await mkdtemp(join(tmpdir(), 'workbench-e2b-sync-'));
        let transferred = 0;
        let materialized = 0;
        const applications: Array<
            Awaited<ReturnType<E2BAssetSnapshot['prepareApplication']>>
        > = [];
        try {
            for (const [index, snapshot] of this.snapshots.entries()) {
                if (
                    snapshot.binding.access !== 'read-write' ||
                    !snapshot.sourceIsDirectory
                ) {
                    continue;
                }
                const baseline = this.snapshotBaselines.get(index);
                if (!baseline) {
                    throw new Error(
                        `E2B workspace baseline is unavailable: ${snapshot.binding.hostPath}`
                    );
                }
                const root = snapshot.binding.runtimePath;
                const remoteArchive = `/tmp/workbench-output-${index}.tar.gz`;
                const remoteChanged = `/tmp/workbench-changed-${index}`;
                const remoteDeleted = `/tmp/workbench-deleted-${index}`;
                const command = [
                    `git -C ${quote(root)} add -A`,
                    `git -C ${quote(root)} diff --cached --name-only --diff-filter=ACMRTUXB -z ${quote(baseline)} > ${quote(remoteChanged)}`,
                    `git -C ${quote(root)} diff --cached --name-only --diff-filter=D -z ${quote(baseline)} > ${quote(remoteDeleted)}`,
                    `tar -C ${quote(root)} --null --files-from=${quote(remoteChanged)} --ignore-failed-read -czf ${quote(remoteArchive)}`,
                ].join(' && ');
                requireSuccess(
                    await sandbox.run(command),
                    `Failed to collect E2B workspace changes: ${snapshot.binding.hostPath}`
                );
                const reportedSizes = await Promise.all([
                    sandbox.fileSize(remoteArchive),
                    sandbox.fileSize(remoteDeleted),
                ]);
                if (
                    transferred + reportedSizes[0] + reportedSizes[1] >
                    this.options.maximumTransferBytes
                ) {
                    throw new Error(
                        `E2B output exceeds the ${formatBytes(this.options.maximumTransferBytes)} transfer safety limit`
                    );
                }
                const localArchive = join(directory, `output-${index}.tar.gz`);
                const localDeleted = join(directory, `deleted-${index}`);
                transferred += await downloadE2BFile(
                    sandbox,
                    remoteArchive,
                    localArchive,
                    this.options.maximumTransferBytes - transferred,
                    this.options.maximumTransferBytes
                );
                const deletionBytes = await downloadE2BFile(
                    sandbox,
                    remoteDeleted,
                    localDeleted,
                    this.options.maximumTransferBytes - transferred,
                    this.options.maximumTransferBytes
                );
                transferred += deletionBytes;
                materialized += deletionBytes;
                if (materialized > this.options.maximumTransferBytes) {
                    throw new Error(
                        `E2B output exceeds the ${formatBytes(this.options.maximumTransferBytes)} transfer safety limit`
                    );
                }
                const deletions = (await readFile(localDeleted))
                    .toString('utf8')
                    .split('\0')
                    .filter(Boolean);
                const application = await snapshot.prepareApplication(
                    localArchive,
                    deletions,
                    this.options.maximumTransferBytes - materialized,
                    this.options.maximumTransferBytes
                );
                materialized += application.bytes;
                applications.push(application);
                await sandbox
                    .run(
                        `rm -f ${quote(remoteArchive)} ${quote(remoteChanged)} ${quote(remoteDeleted)}`
                    )
                    .catch(() => {});
            }
            for (const application of applications) await application.apply();
        } finally {
            await Promise.allSettled(
                applications.map((application) => application.cleanup())
            );
            await rm(directory, { recursive: true, force: true });
        }
    }

    private async preflightAssets(sandbox: E2BSandbox): Promise<void> {
        const paths = [
            this.workbench.instructionsPath,
            ...this.workbench.skills.map((skill) => skill.manifestPath),
        ];
        for (const path of paths) {
            const result = await sandbox.run(`test -r ${quote(path)}`);
            if (result.code !== 0) {
                throw new Error(`Required runtime asset is unreadable: ${path}`);
            }
        }
    }

    private async measureInfrastructure(): Promise<RuntimeInfrastructureMetadata> {
        const measuredAt = this.options.now().getTime();
        const fallbackStartedAt = this.sandboxStartedAt ?? measuredAt;
        const base = {
            provider: this.name,
            duration_ms: Math.max(0, measuredAt - fallbackStartedAt),
            maximum_duration_ms: this.options.leaseMilliseconds,
        };
        if (!this.sandbox) {
            return {
                ...base,
                cost: { kind: 'unavailable', currency: 'USD' },
            };
        }
        const info = await this.sandbox.info().catch(() => undefined);
        if (!info) {
            return {
                ...base,
                cost: { kind: 'unavailable', currency: 'USD' },
            };
        }
        const startedAt = info.startedAt.getTime();
        const duration = Math.max(
            0,
            measuredAt - (Number.isFinite(startedAt) ? startedAt : fallbackStartedAt)
        );
        const amount = estimateE2BCost(duration, info.cpuCount, info.memoryMB);
        return {
            ...base,
            duration_ms: duration,
            resources: {
                cpu_count: info.cpuCount,
                memory_mb: info.memoryMB,
            },
            cost: {
                kind: 'estimated',
                currency: 'USD',
                amount_usd: amount,
                source: e2bPricingSource,
            },
        };
    }

    private async findInside(
        sandbox: E2BSandbox,
        name: string
    ): Promise<string | null> {
        const result = await sandbox.run(`command -v ${quote(name)} 2>/dev/null`);
        if (result.code !== 0) return null;
        return result.stdout.trim().split(/\r?\n/)[0] || null;
    }

    private requireReady(): E2BSandbox {
        this.assertAvailable('launch');
        if (!this.ready || !this.sandbox) {
            throw new Error('Runtime preflight must succeed before launch');
        }
        return this.sandbox;
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
}

function requireSuccess(
    result: { code: number; stdout: string; stderr: string },
    message: string
): void {
    if (result.code === 0) return;
    const detail = result.stderr.trim() || result.stdout.trim();
    throw new Error(`${message}${detail ? `: ${detail}` : ''}`);
}

const remoteExclusions = [
    '.env',
    '.env.*',
    '!.env.example',
    '!.env.sample',
    '.ssh',
    '.aws',
    '.gnupg',
    'node_modules',
    '.npmrc',
    '.netrc',
    '.pypirc',
    'id_rsa',
    'id_ed25519',
    'credentials',
    '*.pem',
    '*.key',
    '*.p12',
    '*.pfx',
    '*.kubeconfig',
];
