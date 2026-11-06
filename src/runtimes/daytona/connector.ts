import { DaytonaApi } from './api.js';
import type {
    DaytonaClient,
    DaytonaFetch,
    DaytonaSocket,
    RegistryLogins,
} from './contracts.js';

/**
 * Opens `DaytonaApi` clients that send their requests through one `fetch`,
 * and open their log streams through `socket` when the host supplies one.
 */
export class DaytonaConnector {
    constructor(
        private readonly fetch: DaytonaFetch,
        private readonly apiUrl?: string,
        private readonly registryLogins?: RegistryLogins,
        private readonly socket?: DaytonaSocket
    ) {}

    /**
     * Opens a client for `key`. `apiUrl` selects another API endpoint for this
     * client, and the connector's own endpoint applies when it is left out.
     */
    open(key: string, apiUrl?: string): DaytonaClient {
        const url = apiUrl ?? this.apiUrl;
        return new DaytonaApi({
            apiKey: key,
            fetch: this.fetch,
            ...(url ? { apiUrl: url } : {}),
            ...(this.registryLogins ? { registryLogins: this.registryLogins } : {}),
            ...(this.socket ? { socket: this.socket } : {}),
        });
    }
}
