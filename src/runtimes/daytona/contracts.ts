import type { RuntimeCommandResult } from '../contracts.js';
import type { AssetSource } from '../staging/source.js';

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
    client?: DaytonaClient;
    /** Where staged workspace and package files are read from. Defaults to disk. */
    assets?: AssetSource;
    maxTransferBytes?: number;
    leaseMilliseconds?: number;
    now?: () => Date;
}
