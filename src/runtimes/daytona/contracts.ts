import type { RemoteSandbox } from '../remote/runtime.js';
import type { AssetSource } from '../staging/source.js';
import type { RemoteTransfer } from '../staging/transfer.js';
import type { DaytonaConnector } from './connector.js';
import type { FollowedCommand, LogOutput } from './follow.js';

/** Sandbox resources. Daytona allocates whole CPUs and whole GiB. */
export interface DaytonaResources {
    cpu?: number;
    memoryGb?: number;
    diskGb?: number;
}

export interface DaytonaCreateOptions {
    /**
     * Name of the active snapshot the sandbox is created from. The snapshot
     * carries the image and the resources; Daytona refuses resources on a
     * sandbox created from one.
     */
    snapshot: string;
    labels: Record<string, string>;
    /** Environment set on the sandbox itself. Command environments are separate. */
    env?: Record<string, string>;
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
    /**
     * Mints a new signed URL for `port` that expires after `ttlSeconds`, with
     * the token that expires it early. Both are credentials. A sandbox without
     * it cannot hand out preview URLs to a host.
     */
    signedPreviewUrl?(
        port: number,
        ttlSeconds: number
    ): Promise<DaytonaSignedPreviewUrl>;
    /** Expires a signed URL for `port` before its time. */
    expireSignedPreviewUrl?(port: number, token: string): Promise<void>;
    /**
     * Starts `command` in its own session and follows its standard output as
     * it is written, until stopped. A sandbox without it is read only when
     * asked, so announcements arrive at the end of each turn.
     */
    follow?(
        command: string,
        onStdout: LogOutput,
        onFailure: (error: unknown) => void
    ): Promise<FollowedCommand>;
    info(): Promise<DaytonaSandboxInfo>;
}

/** A signed preview URL and the token that expires it. Both are credentials. */
export interface DaytonaSignedPreviewUrl {
    url: string;
    token: string;
}

export interface DaytonaSandboxSummary {
    id: string;
    labels: Record<string, string>;
    state: string;
}

export interface DaytonaSnapshotOptions {
    name: string;
    /** Image reference the snapshot is made from, pinned to a digest. */
    image: string;
    resources: DaytonaResources;
}

/**
 * A named Daytona snapshot. `state` moves from `pending` through `pulling`
 * and possibly `building` or `snapshotting` to `active`, or ends in `error`
 * or `build_failed` with `errorReason`. Daytona can set an unused snapshot
 * `inactive`, and it is made usable again by activating it.
 */
export interface DaytonaSnapshot {
    name: string;
    id: string;
    state: string;
    errorReason?: string | undefined;
}

/**
 * Interactive terminals (a PTY) are not part of this interface. The Daytona
 * runtime does not support interactive native authentication.
 */
export interface DaytonaClient {
    /**
     * The `sha256:` digest an image reference names. A reference pinned with
     * `@sha256:` is answered without a request.
     */
    imageDigest(reference: string): Promise<string>;
    /** Starts making a snapshot. A name that already exists returns that snapshot. */
    createSnapshot(options: DaytonaSnapshotOptions): Promise<DaytonaSnapshot>;
    getSnapshot(name: string): Promise<DaytonaSnapshot | undefined>;
    /** Deletes a snapshot by name. A snapshot that does not exist is already gone. */
    deleteSnapshot(name: string): Promise<void>;
    /**
     * Makes an inactive snapshot usable again. One that is missing, or no longer
     * inactive, is left as it is.
     */
    activateSnapshot(name: string): Promise<void>;
    createSandbox(options: DaytonaCreateOptions): Promise<DaytonaSandbox>;
    /** Lists sandboxes whose labels include every given label. */
    listSandboxes(labels: Record<string, string>): Promise<DaytonaSandboxSummary[]>;
    getSandbox(id: string): Promise<DaytonaSandbox | undefined>;
    deleteSandbox(id: string): Promise<void>;
    /**
     * Starts a stopped sandbox and resolves once it is started. Its disk is the
     * one it was stopped with; nothing that was in memory survives. A client
     * without it cannot reattach a stopped sandbox.
     */
    startSandbox?(id: string): Promise<DaytonaSandbox>;
    /**
     * Stops a sandbox and resolves once it is stopped. Its filesystem is kept
     * and only its disk is billed. A client without it cannot keep a sandbox.
     */
    stopSandbox?(id: string): Promise<void>;
    /**
     * Sets the wall-clock time to live, counted from now, after which Daytona
     * destroys the sandbox in any state. `0` clears it.
     */
    setSandboxTtl?(id: string, minutes: number): Promise<void>;
    /**
     * Sets how long a sandbox may stay continuously stopped before Daytona
     * deletes it. `-1` disables auto-delete and `0` deletes on stop.
     */
    setAutoDeleteInterval?(id: string, minutes: number): Promise<void>;
    /**
     * Sets how long a sandbox may stay continuously stopped before Daytona
     * archives it. Daytona's default is seven days. A client without it leaves
     * that default in place.
     */
    setAutoArchiveInterval?(id: string, minutes: number): Promise<void>;
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
