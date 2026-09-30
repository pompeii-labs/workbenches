import { createHash, randomBytes } from 'node:crypto';

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
import { RuntimeSecretStore } from '../secrets.js';
import { diskAssetSource } from '../staging/disk-source.js';
import { DaytonaApiClient } from './api-client.js';
import type { DaytonaRuntimeDependencies } from './contracts.js';
import { DaytonaRuntime } from './runtime.js';

const defaultMaximumTransferBytes = 512 * 1_024 * 1_024;
const defaultLeaseMilliseconds = 60 * 60 * 1_000;

export class DaytonaRuntimeProvider implements RuntimeProvider {
    readonly name = 'daytona';

    constructor(private readonly dependencies: DaytonaRuntimeDependencies = {}) {}

    async prepare(request: RuntimePrepareRequest): Promise<PreparedRuntime> {
        const image = this.image(request);
        try {
            new RequirementsPreflight().check(request.workbench);
        } catch (error) {
            throw RuntimeError.from(this.name, 'prepare', error);
        }
        const assets = this.dependencies.assets ?? diskAssetSource;
        const paths = new E2BPathPlan(request, { label: 'Daytona' });
        await paths.verify(assets);
        new WorkbenchPreflight({
            environment: paths.environment(),
        }).checkConfiguration(paths.remap(request.workbench));
        const client =
            this.dependencies.client ??
            (() => {
                const key = RuntimeSecretStore.daytonaKey(request.environment);
                return key
                    ? new DaytonaApiClient({
                          apiKey: key,
                          ...(request.environment.DAYTONA_API_URL?.trim()
                              ? { apiUrl: request.environment.DAYTONA_API_URL }
                              : {}),
                      })
                    : null;
            })();
        if (!client) {
            throw new RuntimeError(
                this.name,
                'prepare',
                'DAYTONA_API_KEY is required for the Daytona runtime. Run wb connect --runtime daytona once, or set DAYTONA_API_KEY.'
            );
        }
        const run = request.run ?? {
            id: `wb_${randomBytes(16).toString('hex')}`,
            scope: createHash('sha256')
                .update(request.workspaceDirectory)
                .digest('hex')
                .slice(0, 24),
        };
        return new DaytonaRuntime({
            request,
            client,
            paths,
            assets,
            image,
            run,
            maximumTransferBytes:
                this.dependencies.maxTransferBytes ?? defaultMaximumTransferBytes,
            leaseMilliseconds:
                this.dependencies.leaseMilliseconds ?? defaultLeaseMilliseconds,
            now: this.dependencies.now ?? (() => new Date()),
        });
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
