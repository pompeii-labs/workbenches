import type { ResolvedWorkbench } from '../../types.js';
import type { RuntimeCommandResult } from '../contracts.js';
import type { AssetSource } from '../staging/source.js';
import type { RemoteTransfer } from '../staging/transfer.js';

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
    /** The sandbox is destroyed by the provider after this long, even if abandoned. */
    leaseMinutes: number;
}

export interface DaytonaRunOptions {
    cwd?: string;
    env?: Record<string, string>;
    /** Run with root privileges. Used only to provision staging directories. */
    user?: 'root';
}

export interface DaytonaProcessOptions {
    cwd?: string;
    env?: Record<string, string>;
    stdin?: boolean;
    onStdout?: (data: string) => void | Promise<void>;
    onStderr?: (data: string) => void | Promise<void>;
}

/** A command started in the background. */
export interface DaytonaProcess {
    wait(): Promise<RuntimeCommandResult>;
    sendStdin(data: string | Uint8Array): Promise<void>;
    closeStdin(): Promise<void>;
    kill(): Promise<void>;
}

export interface DaytonaSandboxInfo {
    cpuCount: number;
    memoryMB: number;
    diskGb: number;
    createdAt?: Date;
}

export interface DaytonaSandbox {
    readonly id: string;
    /**
     * The sandbox's state when it was looked up, for example `started` or
     * `stopped`. A client that does not report state leaves it out, and the
     * sandbox is assumed to be running.
     */
    readonly state?: string | undefined;
    /** Runs a shell command to completion. Standard error is folded into `stdout`. */
    run(command: string, options?: DaytonaRunOptions): Promise<RuntimeCommandResult>;
    /** Starts a shell command and streams its output. */
    start(command: string, options?: DaytonaProcessOptions): Promise<DaytonaProcess>;
    upload(path: string, data: Uint8Array): Promise<void>;
    download(path: string): Promise<ReadableStream<Uint8Array>>;
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
 * runtime does not support interactive native authentication yet.
 */
export interface DaytonaClient {
    createSandbox(options: DaytonaCreateOptions): Promise<DaytonaSandbox>;
    /** Lists sandboxes whose labels include every given label. */
    listSandboxes(labels: Record<string, string>): Promise<DaytonaSandboxSummary[]>;
    getSandbox(id: string): Promise<DaytonaSandbox | undefined>;
    deleteSandbox(id: string): Promise<void>;
}

export interface DaytonaRuntimeDependencies {
    /** Talks to Daytona. Without one, the provider builds a `DaytonaApiClient` from `apiKey`. */
    client?: DaytonaClient;
    /**
     * The API key for the default client: the key itself, or a function of the
     * request environment for a host that resolves it per run. A
     * `DAYTONA_API_KEY` in the request environment takes precedence. The
     * provider reads no store of its own.
     */
    apiKey?:
        | string
        | ((environment: Record<string, string | undefined>) => string | undefined);
    /** The API endpoint for the default client. `DAYTONA_API_URL` in the request environment takes precedence. */
    apiUrl?: string;
    /**
     * Where staged workspace and package files are read from. Required, since
     * the provider has no storage of its own. The CLI passes the local disk;
     * `MemoryAssetSource` serves a host that holds files in memory.
     */
    assets?: AssetSource;
    /**
     * How files are packed into the sandbox and collected from it. Defaults to
     * `memoryTransfer`, which needs no storage. The CLI passes `diskTransfer`.
     */
    transfer?: RemoteTransfer;
    /**
     * Names of the model provider environment variables a Workbench's routes
     * use, which the runtime forwards into the sandbox alongside the manifest's
     * own. Without it only the manifest's variables are forwarded.
     */
    providerEnvironment?: (workbench: ResolvedWorkbench) => readonly string[];
    maxTransferBytes?: number;
    leaseMilliseconds?: number;
    now?: () => Date;
}
