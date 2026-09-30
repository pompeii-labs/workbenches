import type {
    OutcomeSink,
    RuntimeOutcomeCollection,
} from '../../outcomes/collection.js';
import type {
    ResolvedWorkbench,
    RunnerInvocation,
    SpawnedRunner,
    WorkbenchWorkspaceBinding,
} from '../../types.js';
import { type PreflightResult, WorkbenchPreflight } from '../../workbench/preflight.js';
import { RequirementsPreflight } from '../../workbench/requirements.js';
import { requirementsOf } from '../../workbench/runtimes.js';
import { workspaceEnvironment } from '../../workbench/workspace-environment.js';
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
import type { E2BPathPlan } from '../e2b/paths.js';
import { definedEnvironment, quote, shellCommand } from '../e2b/shell.js';
import { stageSnapshots } from '../e2b/staging.js';
import { workspaceTracking } from '../e2b/tracking.js';
import { RuntimeError } from '../error.js';
import { runLabels } from '../labels.js';
import {
    type ActiveRemoteProcess,
    launchRemoteProcess,
    type RemoteCommand,
} from '../remote-process.js';
import {
    installRepositoryTools,
    needsRepositoryTools,
    probeRepositoryTools,
} from '../repository-tools.js';
import type { AssetSource } from '../staging/source.js';
import type { RemoteTransfer, StagedAsset } from '../staging/transfer.js';
import type { DaytonaClient, DaytonaResources, DaytonaSandbox } from './contracts.js';
import { type SandboxShell, sandboxShell } from './shell.js';

const label = 'Daytona';
const servicePort = 4096;

/**
 * True when something accepts connections on the port inside the sandbox. It
 * needs `bash` for its `/dev/tcp` redirection or `curl`, and reports a closed
 * port otherwise.
 */
const portListening = (port: number) =>
    [
        'if command -v bash >/dev/null 2>&1; then',
        `  bash -c '(exec 3<>/dev/tcp/127.0.0.1/${port}) 2>/dev/null'`,
        'elif command -v curl >/dev/null 2>&1; then',
        `  curl -s -o /dev/null --max-time 2 http://127.0.0.1:${port}/; code=$?`,
        '  [ "$code" != 7 ] && [ "$code" != 28 ] && [ "$code" != 6 ]',
        'else',
        '  exit 1',
        'fi',
    ].join('\n');

export interface DaytonaRuntimeOptions {
    request: RuntimePrepareRequest;
    client: DaytonaClient;
    paths: E2BPathPlan;
    assets: AssetSource;
    transfer: RemoteTransfer;
    /**
     * Bind to a sandbox an earlier run created instead of creating one. Nothing
     * is uploaded. The assets the request names are read again to record what
     * was staged, so they must be unchanged since then.
     */
    existing?: { sandboxId: string };
    image: string;
    run: { id: string; scope: string };
    maximumTransferBytes: number;
    leaseMilliseconds: number;
    now(): Date;
}

/** Sandbox resources for a Workbench's requirements. Daytona allocates whole units. */
export function daytonaResources(
    requirements: ReturnType<typeof requirementsOf>
): DaytonaResources {
    return {
        ...(requirements.cpu === undefined ? {} : { cpu: requirements.cpu }),
        ...(requirements.memory_gb === undefined
            ? {}
            : { memoryGb: Math.ceil(requirements.memory_gb) }),
        ...(requirements.disk_gb === undefined
            ? {}
            : { diskGb: Math.ceil(requirements.disk_gb) }),
    };
}

/**
 * A Daytona sandbox created from the manifest image. The runner runs inside it
 * and the engine drives it from outside. Each execution gets a fresh sandbox,
 * unless the runtime was bound to an existing one with `existing`.
 */
export class DaytonaRuntime implements PreparedRuntime {
    readonly name = 'daytona';
    readonly nativeAuthentication = 'unavailable' as const;
    readonly workbench: ResolvedWorkbench;
    readonly workspaceDirectory: string;
    readonly environment: Record<string, string | undefined>;
    readonly workspaces: WorkbenchWorkspaceBinding[];
    readonly preparation: RuntimePreparation;
    private readonly active = new Set<ActiveRemoteProcess>();
    private sandbox: DaytonaSandbox | undefined;
    private shell: SandboxShell | undefined;
    private snapshots: StagedAsset[] = [];
    private readonly snapshotBaselines = new Map<number, string>();
    private readonly persistedState = new Set<number>();
    private statePersistence: Promise<void> | undefined;
    private outcomeCollection: Promise<RuntimeOutcomeCollection> | undefined;
    private previewUrl: Promise<string> | undefined;
    private ready = false;
    private cleaned = false;
    private sandboxStartedAt: number | undefined;
    private finalInfrastructure: RuntimeInfrastructureMetadata | undefined;

    constructor(private readonly options: DaytonaRuntimeOptions) {
        this.preparation = {
            kind: 'image',
            reference: options.image,
            immutableReference: options.image,
        };
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
            ...workspaceEnvironment(this.workspaces),
        };
        this.workbench = options.paths.remap(options.request.workbench);
    }

    /** The Daytona sandbox id, once the sandbox exists. */
    get sandboxId(): string | undefined {
        return this.sandbox?.id;
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
        const image = this.options.image;
        const names = [
            'git',
            'tar',
            this.workbench.manifest.runner,
            ...this.workbench.manifest.tools,
            ...(this.options.request.repository?.delivery === 'pr' ? ['gh'] : []),
        ];
        const paths = await Promise.all(
            names.map((name) => this.findInside(sandbox, name))
        );
        if (!paths[0]) {
            throw new Error(
                this.options.request.repository
                    ? `Engine-managed Git is unavailable in the ${label} sandbox from image ${image}`
                    : `Git is unavailable in ${label} image ${image}; ${label} workspace outcome collection requires git`
            );
        }
        if (!paths[1]) {
            throw new Error(
                `Tar is unavailable in ${label} image ${image}; ${label} workspace outcome collection requires tar`
            );
        }
        const tarCapabilities = await sandbox.run('tar --help 2>&1');
        if (
            tarCapabilities.code !== 0 ||
            !`${tarCapabilities.stdout}\n${tarCapabilities.stderr}`.includes('--null')
        ) {
            throw new Error(
                `GNU tar is unavailable in ${label} image ${image}; ${label} workspace outcome collection requires tar --null support`
            );
        }
        const runnerPath = paths[2];
        if (!runnerPath) {
            throw new Error(
                `Runner CLI is unavailable in ${label} image ${image}: ${this.workbench.manifest.runner}`
            );
        }
        const tools = this.workbench.manifest.tools.map((name, index) => {
            const path = paths[index + 3];
            if (!path) {
                throw new Error(
                    `Required CLI tool is unavailable in ${label} image ${image}: ${name}`
                );
            }
            return { name, path };
        });
        if (this.options.request.repository?.delivery === 'pr' && !paths.at(-1)) {
            throw new Error(
                `Engine-managed GitHub CLI (gh) is unavailable in the ${label} sandbox from image ${image}`
            );
        }
        await this.preflightAssets(sandbox);
        this.ready = true;
        return {
            runner: { name: this.workbench.manifest.runner, path: runnerPath },
            tools,
            workspaces: this.workspaces,
            requirements: new RequirementsPreflight().check(
                this.options.request.workbench
            ),
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

    async interact(_invocation: RunnerInvocation): Promise<number> {
        throw new Error(
            `Interactive terminals are not supported on the ${this.name} runtime yet`
        );
    }

    launch(invocation: RunnerInvocation): SpawnedRunner {
        return this.launchSession(invocation, { stdin: 'ignore' });
    }

    launchSession(
        invocation: RunnerInvocation,
        options: RuntimeSessionOptions
    ): SpawnedRunner {
        const sandbox = this.requireReady();
        const active = launchRemoteProcess({
            stdin: options.stdin === 'pipe',
            start: (callbacks) =>
                sandbox.start(shellCommand(invocation.command), {
                    cwd: invocation.cwd,
                    env: definedEnvironment(invocation.env),
                    stdin: options.stdin === 'pipe',
                    ...callbacks,
                }),
            onExit: (entry) => this.active.delete(entry),
        });
        this.active.add(active);
        return active.process;
    }

    launchService(
        buildInvocation: (binding: RuntimeServiceBinding) => RunnerInvocation
    ): RuntimeService {
        const invocation = buildInvocation({ hostname: '0.0.0.0', port: servicePort });
        const process = this.options.existing
            ? this.attachOrLaunch(invocation)
            : this.launch(invocation);
        return {
            process,
            resolveUrl: async (reportedUrl) => {
                const sandbox = this.requireReady();
                // The preview URL carries its own access token, so the runner's
                // server needs no further credential from Daytona.
                this.previewUrl ??= sandbox.previewUrl(
                    servicePort,
                    this.remainingLeaseSeconds()
                );
                const preview = new URL(await this.previewUrl);
                const url = new URL(reportedUrl);
                url.protocol = preview.protocol;
                url.hostname = preview.hostname;
                url.port = preview.port;
                return url.toString();
            },
        };
    }

    /**
     * For a reconnected sandbox: when the runner's server is already listening,
     * report its address as a fresh server would and leave it running. Otherwise
     * start the server as usual. The server's password is the caller's to keep,
     * since this process never sees the one it was started with.
     */
    private attachOrLaunch(invocation: RunnerInvocation): SpawnedRunner {
        const sandbox = this.requireReady();
        const active = launchRemoteProcess({
            stdin: false,
            start: async (callbacks): Promise<RemoteCommand> => {
                const probe = await sandbox.run(portListening(servicePort));
                if (probe.code !== 0) {
                    return sandbox.start(shellCommand(invocation.command), {
                        cwd: invocation.cwd,
                        env: definedEnvironment(invocation.env),
                        stdin: false,
                        ...callbacks,
                    });
                }
                callbacks.onStdout(
                    `Attached to the running server at http://0.0.0.0:${servicePort}\n`
                );
                let detach: (() => void) | undefined;
                const detached = new Promise<void>((resolve) => {
                    detach = resolve;
                });
                return {
                    wait: async () => {
                        await detached;
                        return { code: 0, stdout: '', stderr: '' };
                    },
                    sendStdin: async () => {},
                    closeStdin: async () => {},
                    // Detaching leaves the server running in the sandbox.
                    kill: async () => detach?.(),
                };
            },
            onExit: (entry) => this.active.delete(entry),
        });
        this.active.add(active);
        return active.process;
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

    async collectOutcome(store: OutcomeSink): Promise<RuntimeOutcomeCollection> {
        if (!this.outcomeCollection) {
            this.outcomeCollection = this.persistNativeState()
                .then(() => this.collectSnapshots(store))
                .catch((error) => {
                    this.outcomeCollection = undefined;
                    throw error;
                });
        }
        return this.outcomeCollection;
    }

    snapshotRepository(store: OutcomeSink) {
        return this.collectSnapshots(store);
    }

    collectOutput(store: OutcomeSink) {
        return this.collector().collectOutput(store);
    }

    async finalizeOutcome(): Promise<void> {}

    async cleanup(): Promise<void> {
        if (this.cleaned) return;
        this.cleaned = true;
        for (const active of this.active) {
            await active.command.then((command) => command.kill()).catch(() => {});
        }
        this.active.clear();
        const failures: unknown[] = [];
        await this.persistNativeState().catch((error) => {
            failures.push(error);
        });
        if (this.sandbox) {
            this.finalInfrastructure = await this.measureInfrastructure();
            await this.options.client
                .deleteSandbox(this.sandbox.id)
                .catch((error) => failures.push(error));
        }
        const snapshotCleanup = await Promise.allSettled(
            this.snapshots.map((snapshot) => snapshot.cleanup())
        );
        for (const result of snapshotCleanup) {
            if (result.status === 'rejected') failures.push(result.reason);
        }
        if (failures[0]) throw failures[0];
    }

    private collector() {
        this.requireReady();
        if (!this.shell)
            throw new Error('Runtime preflight must succeed before launch');
        return this.options.transfer.collector({
            sandbox: this.shell,
            snapshots: this.snapshots,
            baselines: this.snapshotBaselines,
            maximumTransferBytes: this.options.maximumTransferBytes,
            label,
        });
    }

    private collectSnapshots(store: OutcomeSink): Promise<RuntimeOutcomeCollection> {
        return this.collector().collect(store);
    }

    private persistNativeState(): Promise<void> {
        if (!this.shell) return Promise.resolve();
        if (!this.statePersistence) {
            this.statePersistence = this.options.transfer
                .captureNativeState(
                    this.shell,
                    this.snapshots,
                    this.options.maximumTransferBytes,
                    this.persistedState,
                    label
                )
                .catch((error) => {
                    this.statePersistence = undefined;
                    throw error;
                });
        }
        return this.statePersistence;
    }

    private async ensureSandbox(): Promise<DaytonaSandbox> {
        if (this.sandbox) return this.sandbox;
        const snapshots: StagedAsset[] = [];
        const existing = this.options.existing;
        let transferred = 0;
        try {
            for (const binding of this.options.paths.bindings) {
                const snapshot = await this.options.transfer.pack(
                    binding,
                    this.options.maximumTransferBytes - transferred,
                    { source: this.options.assets, label, upload: !existing }
                );
                transferred += snapshot.bytes;
                snapshots.push(snapshot);
            }
            if (existing) return await this.attach(existing.sandboxId, snapshots);
            const sandbox = await this.options.client.createSandbox({
                image: this.options.image,
                labels: runLabels(this.options.run, label),
                resources: daytonaResources(requirementsOf(this.workbench.manifest)),
                leaseMinutes: Math.max(
                    1,
                    Math.ceil(this.options.leaseMilliseconds / 60_000)
                ),
            });
            this.sandbox = sandbox;
            this.shell = sandboxShell(sandbox);
            this.sandboxStartedAt = this.options.now().getTime();
            this.snapshots = snapshots;
            if (needsRepositoryTools(this.options.request)) {
                const probe = await sandbox.run(probeRepositoryTools);
                if (probe.code !== 0) {
                    const missing = probe.stdout.trim() || 'git, gh';
                    const install = await sandbox.run(installRepositoryTools, {
                        user: 'root',
                    });
                    if (install.code !== 0) {
                        const detail = install.stdout.trim() || install.stderr.trim();
                        throw new Error(
                            detail.includes('root access is required')
                                ? `The ${label} sandbox image is missing ${missing} and cannot install it without root: the image must ship git and gh or allow root`
                                : `Failed to provision Git tools in the ${label} sandbox: ${detail}`
                        );
                    }
                }
            }
            await stageSnapshots({
                sandbox: this.shell,
                snapshots,
                home: this.environment.HOME ?? '/tmp/workbench-home',
                baselines: this.snapshotBaselines,
                label,
                uploader: {
                    upload: async (remotePath, snapshot) =>
                        sandbox.upload(remotePath, await snapshot.archiveBytes()),
                },
            });
            return sandbox;
        } catch (error) {
            // A sandbox this runtime did not create is not its to delete.
            if (this.sandbox && !existing) {
                await this.options.client
                    .deleteSandbox(this.sandbox.id)
                    .catch(() => {});
            }
            this.sandbox = undefined;
            this.shell = undefined;
            this.sandboxStartedAt = undefined;
            await Promise.allSettled(snapshots.map((snapshot) => snapshot.cleanup()));
            this.snapshots = [];
            this.snapshotBaselines.clear();
            throw error;
        }
    }

    /**
     * Binds to a sandbox that is already running. It checks the sandbox exists
     * and is started, then recovers each workspace's Git baseline from the
     * sandbox itself: staging committed it first, so the root commit is it.
     */
    private async attach(
        sandboxId: string,
        snapshots: StagedAsset[]
    ): Promise<DaytonaSandbox> {
        const sandbox = await this.options.client.getSandbox(sandboxId);
        if (!sandbox) {
            throw new Error(`${label} sandbox does not exist: ${sandboxId}`);
        }
        if (sandbox.state !== undefined && sandbox.state !== 'started') {
            throw new Error(
                `${label} sandbox ${sandboxId} is ${sandbox.state}, not running`
            );
        }
        this.sandbox = sandbox;
        this.shell = sandboxShell(sandbox);
        this.snapshots = snapshots;
        const created = (await sandbox.info().catch(() => undefined))?.createdAt;
        this.sandboxStartedAt = (created ?? this.options.now()).getTime();
        for (const [index, snapshot] of snapshots.entries()) {
            const tracked =
                snapshot.binding.access === 'read-write' &&
                snapshot.sourceIsDirectory &&
                snapshot.binding.kind !== 'outcome' &&
                snapshot.binding.kind !== 'git';
            if (!tracked) continue;
            const tracking = workspaceTracking(snapshots, index);
            const result = await sandbox.run(
                `${tracking.git} rev-list --max-parents=0 HEAD`
            );
            const baseline = result.stdout.trim().split(/\s+/).at(-1) ?? '';
            if (result.code !== 0 || !/^[a-f0-9]{40,64}$/.test(baseline)) {
                throw new Error(
                    `Cannot find the workspace baseline in the ${label} sandbox: ${snapshot.binding.hostPath}`
                );
            }
            this.snapshotBaselines.set(index, baseline);
        }
        return sandbox;
    }

    private async preflightAssets(sandbox: DaytonaSandbox): Promise<void> {
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

    private remainingLeaseSeconds(): number {
        const elapsed = this.options.now().getTime() - (this.sandboxStartedAt ?? 0);
        return Math.max(60, (this.options.leaseMilliseconds - elapsed) / 1_000);
    }

    private async measureInfrastructure(): Promise<RuntimeInfrastructureMetadata> {
        const measuredAt = this.options.now().getTime();
        const base = {
            provider: this.name,
            duration_ms: Math.max(
                0,
                measuredAt - (this.sandboxStartedAt ?? measuredAt)
            ),
            maximum_duration_ms: this.options.leaseMilliseconds,
            cost: { kind: 'unavailable', currency: 'USD' } as const,
        };
        const info = await this.sandbox?.info().catch(() => undefined);
        if (!info) return base;
        return {
            ...base,
            resources: { cpu_count: info.cpuCount, memory_mb: info.memoryMB },
        };
    }

    private async findInside(
        sandbox: DaytonaSandbox,
        name: string
    ): Promise<string | null> {
        const result = await sandbox.run(`command -v ${quote(name)} 2>/dev/null`);
        if (result.code !== 0) return null;
        return result.stdout.trim().split(/\r?\n/)[0] || null;
    }

    private requireReady(): DaytonaSandbox {
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
