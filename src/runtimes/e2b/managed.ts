import { RuntimeSecretStore } from '../secrets.js';
import type {
    E2BClient,
    E2BManagedSandbox,
    E2BRuntimeDependencies,
} from './contracts.js';
import { E2BSdkClient } from './sdk.js';

export type ManagedE2BSandbox = E2BManagedSandbox;

export class E2BManagedSandboxes {
    private constructor(
        private readonly client: E2BClient,
        readonly scope: string
    ) {}

    static connect(
        scope: string,
        environment: Record<string, string | undefined> = process.env,
        dependencies: E2BRuntimeDependencies = {}
    ): E2BManagedSandboxes | undefined {
        validateScope(scope);
        const client =
            dependencies.client ??
            (() => {
                const key = RuntimeSecretStore.e2bKey(environment);
                return key ? new E2BSdkClient(key) : null;
            })();
        return client ? new E2BManagedSandboxes(client, scope) : undefined;
    }

    async list(): Promise<ManagedE2BSandbox[]> {
        return (await this.client.listManaged(this.scope)).filter((sandbox) =>
            /^wb_[a-z0-9]{20,64}$/.test(sandbox.runId)
        );
    }

    remove(sandbox: ManagedE2BSandbox): Promise<void> {
        return this.client.killSandbox(sandbox.id);
    }
}

function validateScope(scope: string): void {
    if (!/^[a-f0-9]{24}$/.test(scope)) {
        throw new Error(`Invalid managed Workbench scope: ${scope}`);
    }
}
