import type { RunnerInvocation } from '../../types.js';
import { type PreflightResult, WorkbenchPreflight } from '../../workbench/preflight.js';
import { requirementsOf } from '../../workbench/runtimes.js';
import type {
    RuntimeInfrastructureMetadata,
    RuntimePreparation,
    RuntimeService,
    RuntimeServiceBinding,
} from '../contracts.js';
import { RuntimeError } from '../error.js';
import { runLabels } from '../remote/labels.js';
import { RemoteProcess } from '../remote/process.js';
import { RemoteRuntime, type RemoteRuntimeOptions } from '../remote/runtime.js';
import { type ArchiveUpload, AssetStage } from '../remote/stage.js';
import { needsRepositoryTools } from '../repository-tools.js';
import { runnerExecutable } from '../runner.js';
import type { StagedAsset } from '../staging/transfer.js';
import type {
    DaytonaClient,
    DaytonaClock,
    DaytonaResources,
    DaytonaSandbox,
} from './contracts.js';
import { PreviewUrl } from './preview.js';
import { ServiceLauncher } from './service.js';
import { SandboxSetup } from './setup.js';

/** The port a runner's server binds to inside the sandbox. */
const servicePort = 4096;
/** A sandbox that cannot be deleted is retried this many times, then reported. */
const maximumDeleteAttempts = 4;
const firstDeleteRetryDelayMs = 1_000;

/** A client that can stop a sandbox and set the lifetimes that keep it. */
type KeepingClient = DaytonaClient &
    Required<
        Pick<DaytonaClient, 'stopSandbox' | 'setAutoDeleteInterval' | 'setSandboxTtl'>
    >;

function canKeep(client: DaytonaClient): client is KeepingClient {
    return Boolean(
        client.stopSandbox && client.setAutoDeleteInterval && client.setSandboxTtl
    );
}

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

/**
 * What a sandbox gets for a requirement the Workbench does not declare. Daytona's
 * own default of 1 vCPU and 1 GiB is too small for a runner server plus tools. A
 * declared value always wins, including a smaller one.
 */
const daytonaDefaultResources = { cpu: 2, memoryGb: 4 } as const;

/** Sandbox resources for a Workbench's requirements. Daytona allocates whole units. */
export function daytonaResources(
    requirements: ReturnType<typeof requirementsOf>
): DaytonaResources {
    return {
        cpu: requirements.cpu ?? daytonaDefaultResources.cpu,
        memoryGb:
            requirements.memory_gb === undefined
                ? daytonaDefaultResources.memoryGb
                : Math.ceil(requirements.memory_gb),
        ...(requirements.disk_gb === undefined
            ? {}
            : { diskGb: Math.ceil(requirements.disk_gb) }),
    };
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
    /** Set while a sandbox this runtime created could not be deleted. */
    private undeleted: string | undefined;
    /** Set by `suspend`: the client that keeps the sandbox and for how long. */
    private keeping: { client: KeepingClient; minutes: number } | undefined;

    constructor(options: DaytonaRuntimeOptions) {
        super(options);
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
        if (this.cleaned) fail('Runtime has already been cleaned up');
        if (!this.sandbox) fail('There is no Daytona sandbox to suspend');
        const client = this.options.client;
        if (!canKeep(client)) {
            return fail(
                'This Daytona client cannot stop sandboxes or change their lifetime, so the sandbox cannot be kept'
            );
        }
        this.keeping = { client, minutes: keepMinutes };
        await this.cleanup();
    }

    /**
     * Cleans up as every remote runtime does. When the sandbox could not be
     * deleted, the runtime is not clean, so a later call deletes it again.
     */
    override async cleanup(): Promise<void> {
        if (this.cleaned && this.undeleted) {
            await this.deleteSandbox(this.undeleted);
            this.undeleted = undefined;
            return;
        }
        await super.cleanup();
    }

    /**
     * Deletes the sandbox, trying again a few times, or keeps it when the
     * runtime is suspending, and records a failure that names it so the user
     * can delete it themselves.
     */
    protected async destroy(failures: unknown[]): Promise<void> {
        if (!this.sandbox) return;
        const id = this.sandbox.id;
        try {
            if (this.keeping) await this.keep(id, this.keeping);
            else await this.deleteSandbox(id);
        } catch (error) {
            this.undeleted = id;
            failures.push(error);
        }
    }

    /**
     * Stops sandbox `id` and lets Daytona delete it after `minutes` stopped.
     * Daytona archives a stopped sandbox after seven days by default, so the
     * archive deadline is set one minute past the delete deadline: the sandbox
     * is deleted before it can be archived.
     */
    private async keep(
        id: string,
        { client, minutes }: { client: KeepingClient; minutes: number }
    ): Promise<void> {
        try {
            await client.stopSandbox(id);
            await client.setAutoArchiveInterval?.(id, minutes + 1);
            await client.setAutoDeleteInterval(id, minutes);
            // Daytona's TTL destroys a sandbox in any state, so it is cleared last.
            await client.setSandboxTtl(id, 0);
        } catch (error) {
            throw new RuntimeError(
                this.name,
                'cleanup',
                `Daytona sandbox ${id} was not suspended: ${error instanceof Error ? error.message : String(error)}. Call cleanup to delete it.`,
                { cause: error }
            );
        }
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
                new ServiceLauncher(this.requireReady(), invocation, servicePort),
                false
            )
        );
    }

    /**
     * Deletes sandbox `id`, waiting longer between each of a few attempts. The
     * error after the last attempt names the sandbox.
     */
    private async deleteSandbox(id: string): Promise<void> {
        for (let attempt = 1; ; attempt++) {
            try {
                await this.options.client.deleteSandbox(id);
                return;
            } catch (error) {
                if (attempt >= maximumDeleteAttempts) {
                    throw new RuntimeError(
                        this.name,
                        'cleanup',
                        `Daytona sandbox ${id} was not deleted after ${attempt} attempts: ${error instanceof Error ? error.message : String(error)}. Delete it with the Daytona dashboard or API.`,
                        { cause: error }
                    );
                }
                await this.options.clock.sleep(
                    firstDeleteRetryDelayMs * 2 ** (attempt - 1)
                );
            }
        }
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
            const sandbox = await this.options.client.createSandbox({
                image: this.options.image,
                labels: runLabels(this.options.run, 'Daytona'),
                resources: daytonaResources(requirementsOf(this.workbench.manifest)),
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
                await this.deleteSandbox(created).catch((failure) => {
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
            if (starting) await this.restore(sandboxId);
            throw error;
        }
    }

    /**
     * Puts a sandbox this runtime started back as it was kept: stopped, with no
     * lease. The lease is cleared only once the sandbox is stopped, and when
     * either step fails the lease still bounds the sandbox.
     */
    private async restore(sandboxId: string): Promise<void> {
        const client = this.options.client;
        await client
            .stopSandbox?.(sandboxId)
            .then(() => client.setSandboxTtl?.(sandboxId, 0))
            .catch(() => {});
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
