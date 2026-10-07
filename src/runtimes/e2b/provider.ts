import { AuthenticationRequiredError } from '../../connections/error.js';
import type { PreparedRuntime, RuntimePrepareRequest } from '../contracts.js';
import { DiskTransfer } from '../remote/disk/transfer.js';
import { RemoteProvider } from '../remote/provider.js';
import { RuntimeSecretStore } from '../secrets.js';
import { TransferRules } from '../staging/rules.js';
import type { E2BRuntimeDependencies } from './contracts.js';
import { E2BRuntime } from './runtime.js';
import { E2BSdkClient } from './sdk.js';
import { E2BTemplateManager } from './templates.js';

const defaultMaximumTransferBytes = 512 * 1_024 * 1_024;
const defaultLeaseMilliseconds = 60 * 60 * 1_000;

export class E2BRuntimeProvider extends RemoteProvider {
    readonly name = 'e2b';
    private readonly transfer: DiskTransfer;

    constructor(private readonly dependencies: E2BRuntimeDependencies) {
        const rules = new TransferRules('E2B');
        super(rules, dependencies.assets);
        this.transfer = new DiskTransfer(
            dependencies.assets,
            dependencies.local,
            rules
        );
    }

    async prepare(request: RuntimePrepareRequest): Promise<PreparedRuntime> {
        request = this.withoutRemoteSubscription(request);
        const paths = await this.bind(request);
        const client =
            this.dependencies.client ??
            (() => {
                const key = RuntimeSecretStore.key('e2b', request.environment);
                return key ? new E2BSdkClient(key) : null;
            })();
        if (!client) {
            throw new AuthenticationRequiredError(
                'E2B_API_KEY is required for the E2B runtime. Run wb connect --runtime e2b once, or set E2B_API_KEY.'
            );
        }
        const template = await new E2BTemplateManager(client).prepare(request);
        return new E2BRuntime({
            request,
            client,
            paths,
            rules: this.rules,
            transfer: this.transfer,
            preparation: template.preparation,
            requirements: this.requirements,
            run: await this.run(request),
            maximumTransferBytes:
                this.dependencies.maxTransferBytes ?? defaultMaximumTransferBytes,
            leaseMilliseconds:
                this.dependencies.leaseMilliseconds ?? defaultLeaseMilliseconds,
            now: this.dependencies.now ?? (() => new Date()),
            cleanupPreparation: template.cleanup,
        });
    }
}
