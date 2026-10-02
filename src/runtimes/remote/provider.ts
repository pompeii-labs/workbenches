import { WorkbenchPreflight } from '../../workbench/preflight.js';
import { RequirementsPreflight } from '../../workbench/requirements.js';
import type {
    PreparedRuntime,
    RuntimePrepareRequest,
    RuntimeProvider,
} from '../contracts.js';
import { RuntimeError } from '../error.js';
import type { TransferRules } from '../staging/rules.js';
import type { AssetSource } from '../staging/source.js';
import { PathPlan } from './paths.js';

/**
 * A provider whose runtimes execute in a sandbox the engine copies files into.
 * It owns what those providers do before they create a sandbox: check the
 * request, plan the sandbox paths, and name the run. A sandbox provides its own
 * machine, so no host is described to the requirements check.
 */
export abstract class RemoteProvider implements RuntimeProvider {
    abstract readonly name: string;
    readonly placement = 'sandbox' as const;
    protected readonly requirements = new RequirementsPreflight();

    protected constructor(
        protected readonly rules: TransferRules,
        private readonly assets: AssetSource
    ) {}

    abstract prepare(request: RuntimePrepareRequest): Promise<PreparedRuntime>;

    /** Checks the request and plans where its assets go in the sandbox. */
    protected async bind(request: RuntimePrepareRequest): Promise<PathPlan> {
        try {
            this.requirements.check(request.workbench);
        } catch (error) {
            throw RuntimeError.from(this.name, 'prepare', error);
        }
        const paths = new PathPlan(request, this.rules);
        await paths.verify(this.assets);
        new WorkbenchPreflight({
            environment: paths.environment(),
        }).checkConfiguration(paths.remap(request.workbench));
        return paths;
    }

    /** The request's run, or a new one scoped to its workspace. */
    protected async run(
        request: RuntimePrepareRequest
    ): Promise<{ id: string; scope: string }> {
        return (
            request.run ?? {
                id: `wb_${crypto.randomUUID().replaceAll('-', '')}`,
                scope: await this.scope(request.workspaceDirectory),
            }
        );
    }

    /** A stable scope for sandboxes created for one workspace. */
    protected async scope(workspaceDirectory: string): Promise<string> {
        const digest = await crypto.subtle.digest(
            'SHA-256',
            new TextEncoder().encode(workspaceDirectory)
        );
        return [...new Uint8Array(digest)]
            .map((byte) => byte.toString(16).padStart(2, '0'))
            .join('')
            .slice(0, 24);
    }
}
