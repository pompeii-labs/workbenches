import type { RunnerInvocation } from '../../types.js';
import { type PreflightResult, WorkbenchPreflight } from '../../workbench/preflight.js';
import { requirementsOf } from '../../workbench/runtimes.js';
import type {
    RuntimeInfrastructureMetadata,
    RuntimePreparation,
    RuntimePreviewFeed,
    RuntimeService,
    RuntimeServiceBinding,
    RuntimeSignedPreviewUrl,
} from '../contracts.js';
import { RuntimeError } from '../error.js';
import { runLabels } from '../remote/labels.js';
import { RemoteProcess } from '../remote/process.js';
import { RemoteRuntime, type RemoteRuntimeOptions } from '../remote/runtime.js';
import { type ArchiveUpload, AssetStage } from '../remote/stage.js';
import { needsRepositoryTools } from '../repository-tools.js';
import { runnerExecutable } from '../runner.js';
import { shellCommand } from '../staging/shell.js';
import type { StagedAsset } from '../staging/transfer.js';
import type { DaytonaClient, DaytonaClock, DaytonaSandbox } from './contracts.js';
import { SandboxLifetime } from './lifetime.js';
import { PreviewUrl } from './preview.js';
import { SandboxPreviews } from './previews.js';
import { ServiceLauncher } from './service.js';
import { SandboxSetup } from './setup.js';
import { SandboxSnapshot } from './snapshots.js';

/** The port a runner's server binds to inside the sandbox. */
const servicePort = 4096;
/** Ports Daytona's own toolbox, web terminal, and recordings listen on in every sandbox. */
const toolboxPorts = [2280, 22222, 33333];

export interface DaytonaRuntimeOptions extends RemoteRuntimeOptions {
    client: DaytonaClient;
    image: string;
    clock: DaytonaClock;
    /**
     * Bind to a sandbox an earlier run created instead of creating one. Nothing
     * is uploaded. The assets the request names are read again to record what
     * was staged, so they must be unchanged since then.
     */
    existing?: { sandboxId: string };
}

/** Puts a snapshot's archive into the sandbox. The toolbox takes whole byte arrays. */
class DaytonaArchiveUpload implements ArchiveUpload<StagedAsset> {
    constructor(private readonly sandbox: Pick<DaytonaSandbox, 'upload'>) {}

    async upload(remotePath: string, asset: StagedAsset): Promise<void> {
        await this.sandbox.upload(remotePath, await asset.archiveBytes());
    }
}

/**
 * A Daytona sandbox created from the manifest image. The runner runs inside it
 * and the engine drives it from outside. Each execution gets a fresh sandbox,
 * unless the runtime was bound to an existing one with `existing`.
 */
export class DaytonaRuntime extends RemoteRuntime<DaytonaSandbox, StagedAsset> {
    readonly name = 'daytona';
    readonly nativeAuthentication = 'unavailable' as const;
    readonly preparation: RuntimePreparation;
    protected declare readonly options: DaytonaRuntimeOptions;
    private preview: PreviewUrl | undefined;
    private previewFeed: SandboxPreviews | undefined;
    private readonly lifetime: SandboxLifetime;
    /** Set while a sandbox this runtime created could not be deleted. */
    private undeleted: string | undefined;
    /** Set by `suspend`: how many minutes to keep the stopped sandbox. */
    private keeping: number | undefined;
    /** Set by `linger`: how many minutes to keep the sandbox running. */
    private lingerMinutes: number | undefined;
    /** The id of the sandbox while it lingers after the runtime ended. */
    private lingering: string | undefined;

    constructor(options: DaytonaRuntimeOptions) {
        super(options);
        this.lifetime = new SandboxLifetime(options.client, options.clock);
        this.preparation = {
            kind: 'image',
            reference: options.image,
            immutableReference: options.image,
        };
    }

    /**
     * The Daytona sandbox id, once the sandbox exists. It is what `adopt`
     * takes to reconnect, so it stays here and not on the shared base.
     */
    get sandboxId(): string | undefined {
        return this.sandbox?.id;
    }

    /** The run's preview announcements, once preflight staged the helper. */
    get previews(): RuntimePreviewFeed | undefined {
        return this.previewFeed;
    }

    reservedPorts(): number[] {
        return [servicePort, ...toolboxPorts];
    }

    async preflight(): Promise<PreflightResult> {
        this.assertAvailable('preflight');
        const sandbox = await this.ensureSandbox();
        const configuration = new WorkbenchPreflight({
            environment: this.environment,
        }).checkConfiguration(this.workbench);
        const { runnerPath, tools } = await new SandboxSetup(
            sandbox,
            this.options.image
        ).inspect(this.workbench, {
            runner: runnerExecutable(this.options.request),
            repository: Boolean(this.options.request.repository),
            pullRequests: this.options.request.repository?.delivery === 'pr',
        });
        await this.preflightAssets(sandbox);
        if (this.carriesPreviews() && !this.previewFeed) {
            const previews = new SandboxPreviews(sandbox, this.options.rules, () =>
                this.reservedPorts()
            );
            await previews.install();
            this.previewFeed = previews;
        }
        this.ready = true;
        return {
            runner: { name: this.workbench.manifest.runner, path: runnerPath },
            tools,
            workspaces: this.workspaces,
            requirements: this.options.requirements.check(
                this.options.request.workbench
            ),
            ...configuration,
        };
    }

    async interact(_invocation: RunnerInvocation): Promise<number> {
        throw new RuntimeError(
            this.name,
            'launch',
            `Interactive terminals are not supported on the ${this.name} runtime`
        );
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
                this.preview ??= new PreviewUrl(
                    sandbox,
                    servicePort,
                    this.options.clock
                );
                // The preview URL carries its own access token, so the runner's
                // server needs no further credential from Daytona.
                const preview = await this.preview.get(this.leaseSeconds());
                const url = new URL(reportedUrl);
                url.protocol = preview.protocol;
                url.hostname = preview.hostname;
                url.port = preview.port;
                return url.toString();
            },
        };
    }

    /**
     * Keeps the sandbox for a later run instead of deleting it. Running commands
     * are stopped and so is the sandbox, which keeps its filesystem and bills
     * only its disk. Daytona is told to delete it once it has been stopped for
     * `keepMinutes`, and only then is the lease TTL cleared, so a failure part
     * way leaves a sandbox that still expires. Native state is copied out
     * first, as in every cleanup, so a run can resume in a fresh sandbox if
     * this one is gone. The runtime is cleaned up afterwards, and `adopt`
     * starts the sandbox again. When suspending fails, the error names the
     * sandbox and a later `cleanup` deletes it.
     */
    async suspend(keepMinutes: number): Promise<void> {
        const fail = (message: string): never => {
            throw new RuntimeError(this.name, 'cleanup', message);
        };
        if (!Number.isSafeInteger(keepMinutes) || keepMinutes < 1) {
            fail(
                'A suspended Daytona sandbox must be kept for a whole number of minutes'
            );
        }
        if (!this.lifetime.keeps) {
            fail(
                'This Daytona client cannot stop sandboxes or change their lifetime, so the sandbox cannot be kept'
            );
        }
        if (this.lingering) {
            await this.lifetime.keep(this.lingering, keepMinutes);
            this.lingering = undefined;
            return;
        }
        if (this.cleaned) fail('Runtime has already been cleaned up');
        if (!this.sandbox) fail('There is no Daytona sandbox to suspend');
        this.keeping = keepMinutes;
        await this.cleanup();
    }

    /**
     * Ends the runtime like `cleanup` after a run that announced a preview, but
     * leaves the sandbox running with its credential files removed, and sets
     * Daytona's TTL to `minutes` from now so it is destroyed then even if the
     * host is gone. Calling it again while the sandbox lingers sets the TTL
     * again. `cleanup` deletes a lingering sandbox and `suspend` keeps it.
     */
    async linger(minutes: number): Promise<void> {
        const fail = (message: string): never => {
            throw new RuntimeError(this.name, 'cleanup', message);
        };
        if (!Number.isSafeInteger(minutes) || minutes < 1) {
            fail(
                'A lingering Daytona sandbox must be kept for a whole number of minutes'
            );
        }
        if (!this.lifetime.lingers) {
            fail(
                'This Daytona client cannot change a sandbox lifetime, so the sandbox cannot be kept running'
            );
        }
        if (this.lingering) return this.lifetime.extend(this.lingering, minutes);
        if (this.cleaned) fail('Runtime has already been cleaned up');
        if (!this.sandbox) fail('There is no Daytona sandbox to keep running');
        if (!this.previewFeed?.announced) {
            fail(
                'The run announced no preview, so there is nothing to keep the sandbox running for'
            );
        }
        this.lingerMinutes = minutes;
        await this.cleanup();
    }

    /**
     * Mints a new signed URL for an announced preview's port on every call,
     * valid for `ttlSeconds` (1 to 86,400). It works while the run is live and
     * while the sandbox lingers. The URL and token are credentials: they are
     * returned to the caller only, never cached, logged, or emitted.
     */
    async previewUrl(
        port: number,
        ttlSeconds: number
    ): Promise<RuntimeSignedPreviewUrl> {
        return this.runningPreviews().signedUrl(port, ttlSeconds);
    }

    /** Expires a signed URL that `previewUrl` minted for an announced preview's port. */
    async expireSignedPreviewUrl(port: number, token: string): Promise<void> {
        await this.runningPreviews().expire(port, token);
    }

    /**
     * Cleans up as every remote runtime does. When the sandbox could not be
     * deleted, the runtime is not clean, so a later call deletes it again.
     */
    override async cleanup(): Promise<void> {
        if (this.cleaned && this.lingering) {
            await this.lifetime.delete(this.lingering);
            this.lingering = undefined;
            return;
        }
        if (this.cleaned && this.undeleted) {
            await this.lifetime.delete(this.undeleted);
            this.undeleted = undefined;
            return;
        }
        await super.cleanup();
    }

    /**
     * Ends the control session that follows preview announcements, then
     * deletes the sandbox, trying again a few times, keeps it stopped when the
     * runtime is suspending, or leaves it running when it lingers. A failure
     * is recorded with the sandbox named so the user can delete it themselves.
     */
    protected async destroy(failures: unknown[]): Promise<void> {
        if (!this.sandbox) return;
        const sandbox = this.sandbox;
        await this.previewFeed?.stop().catch(() => {});
        try {
            if (this.keeping) {
                await this.lifetime.keep(sandbox.id, this.keeping);
            } else if (this.lingerMinutes) {
                await this.lifetime.linger(
                    sandbox,
                    this.options.paths.bindings.find(
                        (binding) => binding.kind === 'credentials'
                    )?.runtimePath,
                    this.lingerMinutes
                );
                this.lingering = sandbox.id;
            } else {
                await this.lifetime.delete(sandbox.id);
            }
        } catch (error) {
            this.undeleted = sandbox.id;
            failures.push(error);
        }
    }

    /** The runner's command line, with the preview helper first on PATH when the run has one. */
    protected override commandLine(invocation: RunnerInvocation): string {
        const command = shellCommand(invocation.command);
        return this.previewFeed ? this.previewFeed.command(command) : command;
    }

    /** A run with an outbox gets the preview helper, as on the local runtime. */
    private carriesPreviews(): boolean {
        const { purpose, outcome } = this.options.request;
        return outcome !== undefined && (purpose === undefined || purpose === 'run');
    }

    /** The run's previews, while its sandbox runs. */
    private runningPreviews(): SandboxPreviews {
        if (!this.previewFeed || !this.ready || (this.cleaned && !this.lingering)) {
            throw new RuntimeError(
                this.name,
                'launch',
                'The Daytona sandbox is not running with previews'
            );
        }
        return this.previewFeed;
    }

    /**
     * For a reconnected sandbox: when the runner's server is already listening,
     * report its address as a fresh server would and leave it running. Otherwise
     * start the server as usual. The server's password is the caller's to keep,
     * since this process never sees the one it was started with.
     */
    private attachOrLaunch(invocation: RunnerInvocation) {
        return this.track(
            new RemoteProcess(
                new ServiceLauncher(
                    this.requireReady(),
                    invocation,
                    servicePort,
                    this.commandLine(invocation)
                ),
                false
            )
        );
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
                    { upload: !existing }
                );
                transferred += snapshot.bytes;
                snapshots.push(snapshot);
            }
            if (existing) return await this.attach(existing.sandboxId, snapshots);
            const snapshot = await new SandboxSnapshot(
                this.options.client,
                this.options.clock
            ).ready(this.options.image, requirementsOf(this.workbench.manifest));
            const sandbox = await this.options.client.createSandbox({
                snapshot,
                labels: runLabels(this.options.run, 'Daytona'),
                leaseMinutes: this.leaseMinutes(),
            });
            this.sandbox = sandbox;
            this.sandboxStartedAt = this.options.now().getTime();
            this.snapshots = snapshots;
            if (needsRepositoryTools(this.options.request)) {
                await new SandboxSetup(
                    sandbox,
                    this.options.image
                ).provisionRepositoryTools();
            }
            const baselines = await new AssetStage(
                sandbox,
                new DaytonaArchiveUpload(sandbox),
                this.options.rules
            ).stage(snapshots, this.environment.HOME);
            for (const [index, baseline] of baselines) {
                this.snapshotBaselines.set(index, baseline);
            }
            return sandbox;
        } catch (error) {
            // A sandbox this runtime did not create is not its to delete.
            const created = this.sandbox && !existing ? this.sandbox.id : undefined;
            this.sandbox = undefined;
            this.sandboxStartedAt = undefined;
            await Promise.allSettled(snapshots.map((snapshot) => snapshot.cleanup()));
            this.snapshots = [];
            this.snapshotBaselines.clear();
            if (created) {
                await this.lifetime.delete(created).catch((failure) => {
                    throw new RuntimeError(
                        this.name,
                        'prepare',
                        `${error instanceof Error ? error.message : String(error)}. ${failure instanceof Error ? failure.message : String(failure)}`,
                        { cause: error }
                    );
                });
            }
            throw error;
        }
    }

    /** The lease in whole minutes, as Daytona's TTL takes it. */
    private leaseMinutes(): number {
        return Math.max(1, Math.ceil(this.options.leaseMilliseconds / 60_000));
    }

    /**
     * Binds to a sandbox an earlier run created. A started sandbox is used as
     * it is and a stopped or archived one is started first; any other state is
     * refused. The lease is set again, counted from now, before a stopped
     * sandbox is started, so a sandbox this runtime starts expires even if
     * attaching fails. Then each workspace's Git baseline is recovered from the
     * sandbox. When attaching fails after this runtime started the sandbox, it
     * is stopped again and its lease cleared, so the failure leaves it as the
     * earlier run kept it.
     */
    private async attach(
        sandboxId: string,
        snapshots: StagedAsset[]
    ): Promise<DaytonaSandbox> {
        const client = this.options.client;
        let sandbox = await client.getSandbox(sandboxId);
        if (!sandbox) {
            throw new RuntimeError(
                this.name,
                'prepare',
                `Daytona sandbox does not exist: ${sandboxId}`
            );
        }
        const starting =
            (sandbox.state === 'stopped' || sandbox.state === 'archived') &&
            client.startSandbox !== undefined &&
            client.setSandboxTtl !== undefined;
        if (!starting && sandbox.state !== undefined && sandbox.state !== 'started') {
            throw new RuntimeError(
                this.name,
                'prepare',
                `Daytona sandbox ${sandboxId} is ${sandbox.state}, not running`
            );
        }
        await client.setSandboxTtl?.(sandboxId, this.leaseMinutes());
        // This runtime is billed and leased from when it attached, not from
        // when an earlier run created the sandbox.
        this.sandboxStartedAt = this.options.now().getTime();
        try {
            if (starting) sandbox = (await client.startSandbox?.(sandboxId)) ?? sandbox;
            this.sandbox = sandbox;
            this.snapshots = snapshots;
            const baselines = await new AssetStage(
                sandbox,
                new DaytonaArchiveUpload(sandbox),
                this.options.rules
            ).recover(snapshots);
            for (const [index, baseline] of baselines) {
                this.snapshotBaselines.set(index, baseline);
            }
            return sandbox;
        } catch (error) {
            if (starting) await this.lifetime.restore(sandboxId);
            throw error;
        }
    }

    protected async measureInfrastructure(): Promise<RuntimeInfrastructureMetadata> {
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
}
