import type { RuntimeCommandResult } from '../contracts.js';

export interface E2BTemplateSource {
    image?: string;
    dockerfile?: string;
    context?: string;
}

export interface E2BPreparedTemplate {
    name: string;
    immutableReference: string;
    action: 'built' | 'cache-hit';
}

export interface E2BCommandOptions {
    cwd?: string;
    env?: Record<string, string>;
    stdin?: boolean;
    onStdout?: (data: string) => void | Promise<void>;
    onStderr?: (data: string) => void | Promise<void>;
}

export interface E2BCommand {
    readonly pid: number;
    wait(): Promise<RuntimeCommandResult>;
    sendStdin(data: string | Uint8Array): Promise<void>;
    closeStdin(): Promise<void>;
    kill(): Promise<void>;
}

export interface E2BSandboxInfo {
    startedAt: Date;
    endAt: Date;
    cpuCount: number;
    memoryMB: number;
}

export interface E2BSandbox {
    readonly id: string;
    run(
        command: string,
        options?: Omit<E2BCommandOptions, 'stdin'>
    ): Promise<RuntimeCommandResult>;
    start(command: string, options?: E2BCommandOptions): Promise<E2BCommand>;
    upload(path: string, data: ReadableStream<Uint8Array>): Promise<void>;
    download(path: string): Promise<ReadableStream<Uint8Array>>;
    fileSize(path: string): Promise<number>;
    info(): Promise<E2BSandboxInfo>;
    host(port: number): string;
    kill(): Promise<void>;
}

export interface E2BManagedSandbox {
    id: string;
    runId: string;
    state: 'running' | 'paused';
}

export interface E2BClient {
    prepareTemplate(
        source: E2BTemplateSource,
        name: string
    ): Promise<E2BPreparedTemplate>;
    createSandbox(options: {
        template: string;
        metadata: Record<string, string>;
        timeoutMilliseconds: number;
    }): Promise<E2BSandbox>;
    listManaged(scope: string): Promise<E2BManagedSandbox[]>;
    killSandbox(id: string): Promise<void>;
}

export interface E2BRuntimeDependencies {
    client?: E2BClient;
    maxTransferBytes?: number;
    leaseMilliseconds?: number;
    now?: () => Date;
}
