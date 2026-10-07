import { AuthenticationRequiredError } from '../../connections/error.js';
import { requirementsOf, selectedRuntime } from '../../workbench/runtimes.js';
import type { PreparedRuntime, RuntimePrepareRequest } from '../contracts.js';
import { RuntimeError } from '../error.js';
import { RemoteProvider } from '../remote/provider.js';
import { TransferRules } from '../staging/rules.js';
import type {
    DaytonaClient,
    DaytonaClock,
    DaytonaRuntimeDependencies,
} from './contracts.js';
import { DaytonaRuntime } from './runtime.js';

const defaultMaximumTransferBytes = 512 * 1_024 * 1_024;
const defaultLeaseMilliseconds = 60 * 60 * 1_000;
/** Runners that launch their session with piped standard input. Pi does. */
const runnersReadingStandardInput = new Set<string>(['pi']);

export class DaytonaRuntimeProvider extends RemoteProvider {
    readonly name = 'daytona';
    private readonly clock: DaytonaClock;

    constructor(private readonly dependencies: DaytonaRuntimeDependencies) {
        super(new TransferRules('Daytona'), dependencies.assets);
        this.clock = dependencies.clock;
    }

    /** Creates a sandbox from the manifest image and stages the request's assets into it. */
    async prepare(request: RuntimePrepareRequest): Promise<PreparedRuntime> {
        return this.create(request);
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
        return this.create(request, { sandboxId });
    }

    private async create(
        request: RuntimePrepareRequest,
        existing?: { sandboxId: string }
    ): Promise<PreparedRuntime> {
        request = this.withoutRemoteSubscription(request);
        const image = this.image(request);
        const paths = await this.bind(request);
        const client = this.open(request);
        return new DaytonaRuntime({
            request,
            client,
            paths,
            rules: this.rules,
            transfer: this.dependencies.transfer,
            requirements: this.requirements,
            ...(existing ? { existing } : {}),
            image,
            run: await this.run(request),
            maximumTransferBytes:
                this.dependencies.maxTransferBytes ?? defaultMaximumTransferBytes,
            leaseMilliseconds:
                this.dependencies.leaseMilliseconds ?? defaultLeaseMilliseconds,
            now: () => this.clock.now(),
            clock: this.clock,
        });
    }

    /** Opens the client for this request's key. */
    private open(request: RuntimePrepareRequest): DaytonaClient {
        const key = this.dependencies.keys.key('daytona', request.environment);
        if (!key?.trim()) {
            throw new AuthenticationRequiredError(
                'DAYTONA_API_KEY is required for the Daytona runtime. Run wb connect --runtime daytona once, or set DAYTONA_API_KEY.'
            );
        }
        return this.dependencies.connector.open(
            key,
            request.environment.DAYTONA_API_URL?.trim() || undefined
        );
    }

    /**
     * Validates what this provider supports and returns the image to create the
     * sandbox from: the daytona entry's own image.
     */
    private image(request: RuntimePrepareRequest): string {
        const fail = (message: string): never => {
            throw new RuntimeError(this.name, 'prepare', message);
        };
        const selected = selectedRuntime(request.workbench);
        if (selected.class !== 'linux') {
            fail(`class ${selected.class ?? 'unset'} is not available yet`);
        }
        // The toolbox can write to a command's input but cannot close it, so a
        // runner that holds a session open over standard input would hang.
        if (runnersReadingStandardInput.has(request.workbench.manifest.runner)) {
            fail(
                'The daytona runtime does not support runners that read from standard input yet'
            );
        }
        if (requirementsOf(request.workbench.manifest).gpu) {
            fail('GPU requirements are not supported on the daytona runtime yet');
        }
        const image = selected.image;
        if (image === undefined) {
            return fail(
                'The daytona runtime needs an image. Set runtimes.daytona.image.'
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
