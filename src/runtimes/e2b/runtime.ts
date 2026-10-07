import type { RunnerInvocation } from '../../types.js';
import { type PreflightResult, WorkbenchPreflight } from '../../workbench/preflight.js';
import type {
    RuntimeInfrastructureMetadata,
    RuntimePreparation,
    RuntimeService,
    RuntimeServiceBinding,
} from '../contracts.js';
import type { DiskAssetSnapshot } from '../remote/disk/snapshot.js';
import type { DiskTransfer } from '../remote/disk/transfer.js';
import { runLabels } from '../remote/labels.js';
import { RemoteRuntime, type RemoteRuntimeOptions } from '../remote/runtime.js';
import { type ArchiveUpload, AssetStage } from '../remote/stage.js';
import { definedEnvironment, quote, shellCommand } from '../staging/shell.js';
import { SubprocessEnvironmentScrubbing } from '../subprocess-environment.js';
import type { E2BClient, E2BSandbox } from './contracts.js';
import { e2bPricingSource, estimateE2BCost } from './infrastructure.js';
import { E2BOutcomeRecovery } from './recovery.js';
import { terminalDimensions } from './terminal.js';

interface E2BRuntimeOptions extends RemoteRuntimeOptions {
    client: E2BClient;
    /** Packs files into the sandbox and takes outcomes and native state back. */
    transfer: DiskTransfer;
    preparation: RuntimePreparation & {
        kind: 'image';
        reference: string;
        immutableReference: string;
        action: 'built' | 'cache-hit';
    };
    cleanupPreparation(): Promise<void>;
}

/** Streams a snapshot's archive file into the sandbox without reading it into memory. */
class E2BArchiveUpload implements ArchiveUpload<DiskAssetSnapshot> {
    constructor(private readonly sandbox: Pick<E2BSandbox, 'upload'>) {}

    upload(remotePath: string, snapshot: DiskAssetSnapshot): Promise<void> {
        return this.sandbox.upload(remotePath, Bun.file(snapshot.archive).stream());
    }
}

export class E2BRuntime extends RemoteRuntime<E2BSandbox, DiskAssetSnapshot> {
    readonly name = 'e2b';
    readonly nativeAuthentication: 'persistent' | 'unavailable';
    readonly preparation: E2BRuntimeOptions['preparation'];
    subprocessEnvironmentScrubbing: boolean | undefined;
    protected declare readonly options: E2BRuntimeOptions;
    private recovery: E2BOutcomeRecovery | undefined;
    private outcomeFinalized = false;

    constructor(options: E2BRuntimeOptions) {
        super(options);
        this.nativeAuthentication = options.request.credentials
            ? 'persistent'
            : 'unavailable';
        this.preparation = options.preparation;
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
            this.options.request.runnerCommand ?? this.workbench.manifest.runner,
            ...this.workbench.manifest.tools,
            ...(this.options.request.repository?.delivery === 'pr' ? ['gh'] : []),
        ];
        const paths = await Promise.all(
            names.map((name) => this.findInside(sandbox, name))
        );
        if (!paths[0]) {
            throw new Error(
                this.options.request.repository
                    ? `Engine-managed Git is unavailable in E2B template ${this.preparation.immutableReference}`
                    : `Git is unavailable in E2B image ${this.preparation.immutableReference}; E2B workspace outcome collection requires git`
            );
        }
        if (!paths[1]) {
            throw new Error(
                `Tar is unavailable in E2B image ${this.preparation.immutableReference}; E2B workspace outcome collection requires tar`
            );
        }
        const tarCapabilities = await sandbox.run('tar --help 2>&1');
        if (
            tarCapabilities.code !== 0 ||
            !`${tarCapabilities.stdout}\n${tarCapabilities.stderr}`.includes('--null')
        ) {
            throw new Error(
                `GNU tar is unavailable in E2B image ${this.preparation.immutableReference}; E2B workspace outcome collection requires tar --null support`
            );
        }
        const runnerPath = paths[2];
        if (!runnerPath) {
            throw new Error(
                `Runner CLI is unavailable in E2B image ${this.preparation.immutableReference}: ${names[2]}`
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
        if (this.options.request.repository?.delivery === 'pr' && !paths.at(-1)) {
            throw new Error(
                `Engine-managed GitHub CLI (gh) is unavailable in E2B template ${this.preparation.immutableReference}`
            );
        }
        await this.preflightAssets(sandbox);
        const runnerVersion = await this.runnerVersion(sandbox);
        this.subprocessEnvironmentScrubbing =
            await new SubprocessEnvironmentScrubbing().check(
                this.options.request.runnerAuthentication
                    ?.subprocessEnvironmentScrubbing,
                'linux',
                (command) =>
                    sandbox.run(shellCommand(command), {
                        env: {},
                        timeoutMilliseconds: 15_000,
                    })
            );
        this.ready = true;
        return {
            runner: {
                name: this.workbench.manifest.runner,
                path: runnerPath,
                ...(runnerVersion ? { version: runnerVersion } : {}),
            },
            tools,
            workspaces: this.workspaces,
            requirements: this.options.requirements.check(
                this.options.request.workbench
            ),
            ...(this.subprocessEnvironmentScrubbing !== undefined
                ? {
                      subprocessEnvironmentScrubbing:
                          this.subprocessEnvironmentScrubbing,
                  }
                : {}),
            ...configuration,
        };
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

    override async finalizeOutcome(): Promise<void> {
        this.outcomeFinalized = true;
        await this.recovery?.discard();
    }

    protected override async checkpoint(completed: Set<number>): Promise<void> {
        await this.recovery?.progress(completed);
    }

    protected override collectionFailure(error: unknown): unknown {
        if (!this.recovery) return error;
        return new Error(
            `${error instanceof Error ? error.message : String(error)}. Recover with: wb outcome ${this.options.run.id} --recover`,
            { cause: error }
        );
    }

    /**
     * E2B keeps the sandbox, and the workspace archive that stages it, while an
     * outcome that could not be collected is still recoverable. Otherwise it is
     * killed.
     */
    protected async destroy(failures: unknown[]): Promise<void> {
        if (this.retainRecovery() && this.sandbox) {
            await this.recovery
                ?.retain(this.sandbox, this.persistedState)
                .catch((error) => failures.push(error));
        } else {
            await this.sandbox?.kill().catch((error) => failures.push(error));
        }
    }

    protected override releasable(snapshot: DiskAssetSnapshot): boolean {
        return !this.retainRecovery() || snapshot.binding.kind !== 'workspace';
    }

    protected override finishCleanup(): Promise<void> {
        return this.options.cleanupPreparation();
    }

    private retainRecovery(): boolean {
        return Boolean(this.recovery && !this.outcomeFinalized);
    }

    private async ensureSandbox(): Promise<E2BSandbox> {
        if (this.sandbox) return this.sandbox;
        const snapshots: DiskAssetSnapshot[] = [];
        let transferred = 0;
        try {
            if (this.options.request.outcome?.home) {
                const recovery = new E2BOutcomeRecovery(
                    this.options.request.outcome.home,
                    this.options.run
                );
                await recovery.prepare();
                this.recovery = recovery;
            }
            for (const binding of this.options.paths.bindings) {
                const snapshot = await this.options.transfer.pack(
                    binding,
                    this.options.maximumTransferBytes - transferred,
                    binding.kind === 'workspace' && this.recovery
                        ? { persistentDirectory: this.recovery.directory }
                        : {}
                );
                transferred += snapshot.bytes;
                snapshots.push(snapshot);
            }
            const sandbox = await this.options.client.createSandbox({
                template: this.preparation.immutableReference,
                metadata: runLabels(this.options.run, 'E2B'),
                timeoutMilliseconds: this.options.leaseMilliseconds,
            });
            this.sandbox = sandbox;
            this.sandboxStartedAt = this.options.now().getTime();
            this.snapshots = snapshots;
            await this.stageSnapshots(sandbox, snapshots);
            await this.recovery?.checkpoint(
                sandbox,
                snapshots,
                this.snapshotBaselines,
                this.options.maximumTransferBytes
            );
            return sandbox;
        } catch (error) {
            await this.sandbox?.kill().catch(() => {});
            this.sandbox = undefined;
            this.sandboxStartedAt = undefined;
            await Promise.allSettled(snapshots.map((snapshot) => snapshot.cleanup()));
            this.snapshots = [];
            this.snapshotBaselines.clear();
            await this.recovery?.discard().catch(() => {});
            this.recovery = undefined;
            throw error;
        }
    }

    private async stageSnapshots(
        sandbox: E2BSandbox,
        snapshots: DiskAssetSnapshot[]
    ): Promise<void> {
        const baselines = await new AssetStage(
            sandbox,
            new E2BArchiveUpload(sandbox),
            this.options.rules
        ).stage(snapshots, this.environment.HOME);
        for (const [index, baseline] of baselines) {
            this.snapshotBaselines.set(index, baseline);
        }
    }

    protected async measureInfrastructure(): Promise<RuntimeInfrastructureMetadata> {
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
}
