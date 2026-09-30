import { WorkbenchPreflight } from '../../workbench/preflight.js';
import { RequirementsPreflight } from '../../workbench/requirements.js';
import {
    declaredRuntimes,
    requirementsOf,
    selectedRuntime,
} from '../../workbench/runtimes.js';
import type {
    PreparedRuntime,
    RuntimePrepareRequest,
    RuntimeProvider,
} from '../contracts.js';
import { E2BPathPlan } from '../e2b/paths.js';
import { RuntimeError } from '../error.js';
import { memoryTransfer } from '../staging/memory.js';
import { digestBytes } from '../staging/plan.js';
import { DaytonaApiClient } from './api-client.js';
import type { DaytonaClient, DaytonaRuntimeDependencies } from './contracts.js';
import { DaytonaRuntime } from './runtime.js';

const defaultMaximumTransferBytes = 512 * 1_024 * 1_024;
const defaultLeaseMilliseconds = 60 * 60 * 1_000;

export class DaytonaRuntimeProvider implements RuntimeProvider {
    readonly name = 'daytona';

    constructor(private readonly dependencies: DaytonaRuntimeDependencies = {}) {}

    /** Creates a sandbox from the manifest image and stages the request's assets into it. */
    async prepare(request: RuntimePrepareRequest): Promise<PreparedRuntime> {
        return this.bind(request);
    }

    /**
     * Reconnects to a sandbox that an earlier `prepare` created, for example
     * after the process that created it restarted. Nothing is uploaded: the
     * runtime verifies the sandbox exists and is running, recovers each
     * workspace's Git baseline from it, and then launches, collects outcomes, and
     * cleans up as a prepared runtime does. `launchService` attaches to a runner
     * server that is still listening in the sandbox rather than starting another.
     *
     * `request` must describe the same assets as the original, and the files
     * they name must be unchanged since then, because the runtime reads them
     * again to know what was staged. Read the sandbox id from `sandboxId` on the
     * original runtime after its `preflight`, and keep it.
     */
    async adopt(
        request: RuntimePrepareRequest,
        sandboxId: string
    ): Promise<PreparedRuntime> {
        if (!sandboxId.trim()) {
            throw new RuntimeError(this.name, 'prepare', 'A sandbox id is required');
        }
        return this.bind(request, { sandboxId });
    }

    private async bind(
        request: RuntimePrepareRequest,
        existing?: { sandboxId: string }
    ): Promise<PreparedRuntime> {
        const image = this.image(request);
        try {
            new RequirementsPreflight().check(request.workbench);
        } catch (error) {
            throw RuntimeError.from(this.name, 'prepare', error);
        }
        const assets = this.dependencies.assets;
        if (!assets) {
            throw new RuntimeError(
                this.name,
                'prepare',
                'The Daytona runtime needs an asset source. Pass `assets` in its dependencies: the local disk from @pompeii-labs/workbench/runtimes/assets/disk, or any AssetSource.'
            );
        }
        const paths = new E2BPathPlan(request, {
            label: 'Daytona',
            providerEnvironment:
                this.dependencies.providerEnvironment?.(request.workbench) ?? [],
        });
        await paths.verify(assets);
        new WorkbenchPreflight({
            environment: paths.environment(),
        }).checkConfiguration(paths.remap(request.workbench));
        const client = this.dependencies.client ?? this.apiClient(request);
        if (!client) {
            throw new RuntimeError(
                this.name,
                'prepare',
                'DAYTONA_API_KEY is required for the Daytona runtime. Run wb connect --runtime daytona once, or set DAYTONA_API_KEY.'
            );
        }
        const run = request.run ?? {
            id: `wb_${crypto.randomUUID().replaceAll('-', '')}`,
            scope: (
                await digestBytes(new TextEncoder().encode(request.workspaceDirectory))
            )
                .slice('sha256:'.length)
                .slice(0, 24),
        };
        return new DaytonaRuntime({
            request,
            client,
            paths,
            assets,
            transfer: this.dependencies.transfer ?? memoryTransfer,
            ...(existing ? { existing } : {}),
            image,
            run,
            maximumTransferBytes:
                this.dependencies.maxTransferBytes ?? defaultMaximumTransferBytes,
            leaseMilliseconds:
                this.dependencies.leaseMilliseconds ?? defaultLeaseMilliseconds,
            now: this.dependencies.now ?? (() => new Date()),
        });
    }

    private apiClient(request: RuntimePrepareRequest): DaytonaClient | null {
        const configured = this.dependencies.apiKey;
        const key =
            request.environment.DAYTONA_API_KEY?.trim() ||
            (typeof configured === 'function'
                ? configured(request.environment)
                : configured
            )?.trim();
        if (!key) return null;
        const apiUrl =
            request.environment.DAYTONA_API_URL?.trim() || this.dependencies.apiUrl;
        return new DaytonaApiClient({ apiKey: key, ...(apiUrl ? { apiUrl } : {}) });
    }

    /**
     * Validates what this provider supports and returns the image to create the
     * sandbox from: the daytona entry's own image, else the docker entry's.
     */
    private image(request: RuntimePrepareRequest): string {
        const fail = (message: string): never => {
            throw new RuntimeError(this.name, 'prepare', message);
        };
        const selected = selectedRuntime(request.workbench);
        if (selected.class !== 'linux') {
            fail(`class ${selected.class ?? 'unset'} is not available yet`);
        }
        if (requirementsOf(request.workbench.manifest).gpu) {
            fail('GPU requirements are not supported on the daytona runtime yet');
        }
        const image =
            selected.image ??
            declaredRuntimes(request.workbench.manifest).docker?.image;
        if (image === undefined) {
            return fail(
                'The daytona runtime needs an image. Set runtimes.daytona.image, or declare a docker runtime with an image to fall back to.'
            );
        }
        if (typeof image !== 'string') {
            return fail(
                'The daytona runtime creates sandboxes from a published image and cannot build a local Dockerfile. Set runtimes.daytona.image to a published image.'
            );
        }
        return image;
    }
}
