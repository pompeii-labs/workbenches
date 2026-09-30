import { ModelRouter } from '../../models/index.js';
import { RuntimeSecretStore } from '../secrets.js';
import { diskAssetSource, diskTransfer } from '../staging/disk.js';
import type { DaytonaRuntimeDependencies } from './contracts.js';

/**
 * What the CLI gives the Daytona provider: files read from the local disk,
 * transfers staged through temporary files, the API key from the environment or
 * the saved runtime key, and model provider variables from the active catalog.
 * It needs Node compatible `fs`, so a host on another runtime builds its own
 * dependencies instead.
 */
export const diskDaytonaDependencies: DaytonaRuntimeDependencies = {
    assets: diskAssetSource,
    transfer: diskTransfer,
    apiKey: (environment) => RuntimeSecretStore.daytonaKey(environment),
    providerEnvironment: (workbench) =>
        new ModelRouter().providerEnvironmentNames(workbench),
};
