import type { RemoteSandbox } from '../remote/runtime.js';
import type { AssetSource } from '../staging/source.js';
import type { RemoteTransfer } from '../staging/transfer.js';
import type { DaytonaConnector } from './connector.js';

/** Sandbox resources. Daytona allocates whole CPUs and whole GiB. */
export interface DaytonaResources {
    cpu?: number;
    memoryGb?: number;
    diskGb?: number;
}

export interface DaytonaCreateOptions {
    /** Image reference the sandbox is created from. */
    image: string;
    labels: Record<string, string>;
    /** Environment set on the sandbox itself. Command environments are separate. */
    env?: Record<string, string>;
    resources?: DaytonaResources;
    /**
     * Daytona's wall-clock time to live: it destroys the sandbox this many
     * minutes after creation in any state, even if the engine process died.
     */
    leaseMinutes: number;
}

export interface DaytonaSandboxInfo {
    cpuCount: number;
    memoryMB: number;
    diskGb: number;
    createdAt?: Date;
}

export interface DaytonaSandbox extends RemoteSandbox {
    /**
     * The sandbox's state when it was looked up, for example `started` or
     * `stopped`. A client that does not report state leaves it out, and the
     * sandbox is assumed to be running.
     */
    readonly state?: string | undefined;
    upload(path: string, data: Uint8Array): Promise<void>;
    /** A URL that reaches a sandbox port without further credentials. */
    previewUrl(port: number, ttlSeconds: number): Promise<string>;
    info(): Promise<DaytonaSandboxInfo>;
}

export interface DaytonaSandboxSummary {
    id: string;
    labels: Record<string, string>;
    state: string;
}

/**
 * Interactive terminals (a PTY) are not part of this interface. The Daytona
 * runtime does not support interactive native authentication.
 */
export interface DaytonaClient {
    createSandbox(options: DaytonaCreateOptions): Promise<DaytonaSandbox>;
    /** Lists sandboxes whose labels include every given label. */
    listSandboxes(labels: Record<string, string>): Promise<DaytonaSandboxSummary[]>;
    getSandbox(id: string): Promise<DaytonaSandbox | undefined>;
    deleteSandbox(id: string): Promise<void>;
}

/** Sends one HTTP request. Shaped like the platform `fetch`. */
export type DaytonaFetch = (
    input: string | URL | Request,
    init?: RequestInit
) => Promise<Response>;

/** Where the provider finds the API key for a request. */
export interface DaytonaKeys {
    /** The key from the request environment, else the host's own saved key. */
    key(
        provider: 'daytona',
        environment: Record<string, string | undefined>
    ): string | undefined;
}

export interface DaytonaRuntimeDependencies {
    /** How files are packed into the sandbox and collected from it. */
    transfer: RemoteTransfer;
    /** Where staged workspace and package files are read from. */
    assets: AssetSource;
    /** Finds the API key for a request. */
    keys: DaytonaKeys;
    /** Opens a client for a request's key. */
    connector: Pick<DaytonaConnector, 'open'>;
    maxTransferBytes?: number;
    leaseMilliseconds?: number;
    /** Reads the time and waits between retries. */
    clock: DaytonaClock;
}

/** The time source the runtime reads and waits on. */
export interface DaytonaClock {
    now(): Date;
    sleep(milliseconds: number): Promise<void>;
}
