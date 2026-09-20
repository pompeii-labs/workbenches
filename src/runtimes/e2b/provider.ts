import { createHash, randomBytes } from 'node:crypto';
import { WorkbenchPreflight } from '../../workbench/preflight.js';
import type {
    PreparedRuntime,
    RuntimePrepareRequest,
    RuntimeProvider,
} from '../contracts.js';
import { RuntimeError } from '../error.js';
import { RuntimeSecretStore } from '../secrets.js';
import type { E2BRuntimeDependencies } from './contracts.js';
import { E2BPathPlan } from './paths.js';
import { E2BRuntime } from './runtime.js';
import { E2BSdkClient } from './sdk.js';
import { E2BTemplateManager } from './templates.js';

const defaultMaximumTransferBytes = 512 * 1_024 * 1_024;
const defaultLeaseMilliseconds = 60 * 60 * 1_000;

export class E2BRuntimeProvider implements RuntimeProvider {
    readonly name = 'e2b';

    constructor(private readonly dependencies: E2BRuntimeDependencies = {}) {}

    async prepare(request: RuntimePrepareRequest): Promise<PreparedRuntime> {
        const paths = new E2BPathPlan(request);
        await paths.verify();
        new WorkbenchPreflight({
            environment: paths.environment(),
        }).checkConfiguration(paths.remap(request.workbench));
        const client =
            this.dependencies.client ??
            (() => {
                const key = RuntimeSecretStore.e2bKey(request.environment);
                return key ? new E2BSdkClient(key) : null;
            })();
        if (!client) {
            throw new RuntimeError(
                this.name,
                'prepare',
                'E2B_API_KEY is required for the E2B runtime. Run wb connect --runtime e2b once, or set E2B_API_KEY.'
            );
        }
        const template = await new E2BTemplateManager(client).prepare(request);
        const run = request.run ?? {
            id: `wb_${randomBytes(16).toString('hex')}`,
            scope: createHash('sha256')
                .update(request.workspaceDirectory)
                .digest('hex')
                .slice(0, 24),
        };
        return new E2BRuntime({
            request,
            client,
            paths,
            preparation: template.preparation,
            run,
            maximumTransferBytes:
                this.dependencies.maxTransferBytes ?? defaultMaximumTransferBytes,
            leaseMilliseconds:
                this.dependencies.leaseMilliseconds ?? defaultLeaseMilliseconds,
            now: this.dependencies.now ?? (() => new Date()),
            cleanupPreparation: template.cleanup,
        });
    }
}
