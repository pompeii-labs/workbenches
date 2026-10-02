import { WORKBENCH_USER_AGENT } from '../../user-agent.js';
import type { DaytonaFetch } from './contracts.js';

export const defaultDaytonaApiUrl = 'https://app.daytona.io/api';

export interface DaytonaApiOptions {
    apiKey: string;
    /** Sends every request. */
    fetch: DaytonaFetch;
    /** Defaults to the public Daytona API. */
    apiUrl?: string;
    /** Bound on sandbox management calls. Default 30 seconds. */
    requestTimeoutMs?: number;
    /** Bound on one command run to completion. Default 60 minutes. */
    commandTimeoutMs?: number;
    /** Bound on one file transfer. Default 30 minutes. */
    transferTimeoutMs?: number;
    /** How long a new sandbox may take to start. Default 10 minutes. */
    startTimeoutMs?: number;
    /** Delay between polls of a background command. Default 300 milliseconds. */
    pollIntervalMs?: number;
}

export class DaytonaApiError extends Error {
    constructor(
        message: string,
        readonly status?: number
    ) {
        super(message);
        this.name = 'DaytonaApiError';
    }
}

export interface SandboxDto {
    id: string;
    state?: string;
    labels?: Record<string, string>;
    errorReason?: string;
    toolboxProxyUrl?: string;
    cpu?: number;
    memory?: number;
    disk?: number;
    createdAt?: string;
}

interface RequestOptions {
    json?: unknown;
    query?: Record<string, string>;
    body?: FormData;
    accept?: string;
    timeoutMs?: number;
    /** An absolute URL, for toolbox calls. Otherwise the path is under the API URL. */
    absolute?: boolean;
}

/** Authenticated, bounded HTTP. Holds the credential; never logs or echoes it. */
export class DaytonaTransport {
    readonly apiUrl: string;
    readonly requestTimeoutMs: number;
    readonly commandTimeoutMs: number;
    readonly transferTimeoutMs: number;
    readonly startTimeoutMs: number;
    readonly pollIntervalMs: number;
    private readonly fetcher: DaytonaFetch;
    private readonly apiKey: string;

    constructor(options: DaytonaApiOptions) {
        this.apiKey = options.apiKey.trim();
        this.apiUrl = (options.apiUrl?.trim() || defaultDaytonaApiUrl).replace(
            /\/+$/,
            ''
        );
        // Some runtimes require Web platform functions to run with an undefined
        // `this`, so never call the injected function as a method of this client.
        const fetcher = options.fetch;
        this.fetcher = (input, init) => fetcher(input, init);
        this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
        this.commandTimeoutMs = options.commandTimeoutMs ?? 60 * 60_000;
        this.transferTimeoutMs = options.transferTimeoutMs ?? 30 * 60_000;
        this.startTimeoutMs = options.startTimeoutMs ?? 10 * 60_000;
        this.pollIntervalMs = options.pollIntervalMs ?? 300;
    }

    async request(
        method: string,
        path: string,
        options: RequestOptions = {}
    ): Promise<Response> {
        const url = new URL(options.absolute ? path : `${this.apiUrl}${path}`);
        for (const [name, value] of Object.entries(options.query ?? {})) {
            url.searchParams.set(name, value);
        }
        const headers: Record<string, string> = {
            Authorization: `Bearer ${this.apiKey}`,
            'User-Agent': WORKBENCH_USER_AGENT,
            Accept: options.accept ?? 'application/json',
        };
        if (options.json !== undefined) headers['Content-Type'] = 'application/json';
        const response = await this.fetcher(url, {
            method,
            headers,
            ...(options.json !== undefined
                ? { body: JSON.stringify(options.json) }
                : options.body
                  ? { body: options.body }
                  : {}),
            signal: AbortSignal.timeout(options.timeoutMs ?? this.requestTimeoutMs),
        });
        if (!response.ok) {
            const detail = (await response.text().catch(() => '')).slice(0, 500);
            throw new DaytonaApiError(
                `Daytona API ${method} ${url.pathname} failed with ${response.status}${detail ? `: ${detail}` : ''}`,
                response.status
            );
        }
        return response;
    }

    async json<T>(
        method: string,
        path: string,
        options: RequestOptions = {}
    ): Promise<T> {
        const response = await this.request(method, path, options);
        return (await response.json()) as T;
    }

    async waitUntilStarted(id: string): Promise<SandboxDto> {
        const deadline = Date.now() + this.startTimeoutMs;
        for (;;) {
            const dto = await this.json<SandboxDto>(
                'GET',
                `/sandbox/${encodeURIComponent(id)}`
            );
            if (dto.state === 'started') return dto;
            if (
                dto.state === 'error' ||
                dto.state === 'build_failed' ||
                dto.state === 'destroyed' ||
                dto.state === 'destroying'
            ) {
                throw new DaytonaApiError(
                    `Daytona sandbox ${id} entered state ${dto.state}${dto.errorReason ? `: ${dto.errorReason}` : ''}`
                );
            }
            if (Date.now() >= deadline) {
                throw new DaytonaApiError(
                    `Daytona sandbox ${id} did not start within ${Math.round(this.startTimeoutMs / 1000)} seconds (state: ${dto.state ?? 'unknown'})`
                );
            }
            await this.wait(Math.min(1_000, this.pollIntervalMs * 3));
        }
    }

    async toolboxUrl(dto: SandboxDto): Promise<string> {
        const proxy =
            dto.toolboxProxyUrl ??
            (
                await this.json<{ url: string }>(
                    'GET',
                    `/sandbox/${encodeURIComponent(dto.id)}/toolbox-proxy-url`
                )
            ).url;
        return `${proxy.replace(/\/+$/, '')}/${encodeURIComponent(dto.id)}`;
    }

    wait(milliseconds: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, milliseconds));
    }
}
