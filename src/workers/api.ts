import { WORKBENCH_USER_AGENT } from '../user-agent.js';
import { isRecord, type TerminalSize } from './protocol.js';

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export class WorkerApiError extends Error {
    constructor(
        message: string,
        readonly status: number
    ) {
        super(message);
        this.name = 'WorkerApiError';
    }
}

/**
 * The workbenches.dev worker API. Worker keys, run tokens, and the CLI's own
 * login key are sent only as bearer credentials to the API origin and never
 * logged.
 */
export class WorkerApi {
    readonly apiUrl: string;
    readonly #fetch: Fetch;

    constructor(apiUrl: string, fetcher: Fetch = fetch) {
        this.apiUrl = apiUrl.replace(/\/+$/, '');
        this.#fetch = fetcher;
    }

    /** The WebSocket endpoint, on the API origin. */
    get connectUrl(): string {
        const url = new URL(`${this.apiUrl}/v1/workers/connect`);
        url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:';
        return url.toString();
    }

    /** Registers a worker with the CLI's login key; the caller becomes its owner. */
    async register(
        login: string,
        name: string
    ): Promise<{ id: string; slug: string; key: string }> {
        const value = await this.request('/v1/workers', {
            method: 'POST',
            token: login,
            body: { name },
        });
        if (
            !isRecord(value) ||
            !isRecord(value.worker) ||
            typeof value.worker.id !== 'string' ||
            typeof value.worker.slug !== 'string' ||
            typeof value.key !== 'string' ||
            !value.key.startsWith('wbk_')
        )
            throw malformed();
        return { id: value.worker.id, slug: value.worker.slug, key: value.key };
    }

    async revoke(key: string): Promise<void> {
        await this.request('/v1/workers/self', { method: 'DELETE', token: key });
    }

    /**
     * Asks a worker to connect a runner for the caller with the chosen
     * provider and method. Returns its id, and the name of the machine's
     * owner when it is not the caller's own.
     */
    async connect(
        login: string,
        worker: string,
        choice: { runner: string; provider: string; method: string }
    ): Promise<{ id: string; owner: string | null }> {
        const value = await this.request(this.#connections(worker), {
            method: 'POST',
            token: login,
            body: choice,
        });
        if (
            !isRecord(value) ||
            typeof value.id !== 'string' ||
            !value.id ||
            (value.owner !== null && typeof value.owner !== 'string')
        )
            throw malformed();
        return { id: value.id, owner: value.owner };
    }

    /**
     * Opens the person's terminal on their sign-in, at its size, which starts
     * it on the worker. Closing the socket cancels it.
     */
    terminal(login: string, worker: string, id: string, size: TerminalSize): WebSocket {
        const url = new URL(`${this.apiUrl}${this.#connections(worker, id)}/terminal`);
        url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:';
        url.searchParams.set('cols', String(size.cols));
        url.searchParams.set('rows', String(size.rows));
        return new WebSocket(url.toString(), {
            headers: {
                Authorization: `Bearer ${login}`,
                'User-Agent': WORKBENCH_USER_AGENT,
            },
        });
    }

    #connections(worker: string, id?: string): string {
        return `/v1/workers/${encodeURIComponent(worker)}/connections${id ? `/${encodeURIComponent(id)}` : ''}`;
    }

    async uploadOutcome(
        runId: string,
        runToken: string,
        archive: Uint8Array
    ): Promise<void> {
        await this.request(`/v1/runs/${encodeURIComponent(runId)}/outcome`, {
            method: 'PUT',
            token: runToken,
            raw: archive,
            contentType: 'application/gzip',
        });
    }

    private async request(
        path: string,
        options: {
            method?: string;
            token?: string;
            body?: unknown;
            raw?: Uint8Array;
            contentType?: string;
        } = {}
    ): Promise<unknown> {
        let response: Response;
        try {
            response = await this.#fetch(`${this.apiUrl}${path}`, {
                method: options.method ?? 'GET',
                headers: {
                    Accept: 'application/json',
                    'User-Agent': WORKBENCH_USER_AGENT,
                    ...(options.token
                        ? { Authorization: `Bearer ${options.token}` }
                        : {}),
                    ...(options.body !== undefined
                        ? { 'Content-Type': 'application/json' }
                        : options.contentType
                          ? { 'Content-Type': options.contentType }
                          : {}),
                },
                ...(options.body !== undefined
                    ? { body: JSON.stringify(options.body) }
                    : options.raw
                      ? { body: new Uint8Array(options.raw) }
                      : {}),
                signal: AbortSignal.timeout(60_000),
            });
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            throw new WorkerApiError(`Could not reach workbenches.dev: ${detail}`, 0);
        }
        const value: unknown = await response.json().catch(() => null);
        if (!response.ok) {
            const message =
                isRecord(value) &&
                isRecord(value.error) &&
                typeof value.error.message === 'string'
                    ? value.error.message
                    : `Worker request failed (HTTP ${response.status})`;
            throw new WorkerApiError(message, response.status);
        }
        return value;
    }
}

function malformed(): Error {
    return new Error('workbenches.dev returned a malformed worker response');
}
