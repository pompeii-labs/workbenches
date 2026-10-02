import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';

import type {
    DaytonaClient,
    DaytonaClock,
    DaytonaCreateOptions,
    DaytonaRuntimeDependencies,
    DaytonaSandbox,
    DaytonaSandboxInfo,
} from '../../../src/runtimes/daytona/contracts.js';
import { DaytonaRuntimeProvider } from '../../../src/runtimes/daytona/provider.js';
import { identityCommand } from '../../../src/runtimes/remote/directories.js';
import { DiskTransfer } from '../../../src/runtimes/remote/disk/transfer.js';
import type {
    RemoteCommand,
    RemoteCommandOptions,
} from '../../../src/runtimes/remote/process.js';
import type { RemoteRunOptions } from '../../../src/runtimes/remote/runtime.js';
import {
    installRepositoryTools,
    probeRepositoryTools,
} from '../../../src/runtimes/repository-tools.js';
import { RuntimeSecretStore } from '../../../src/runtimes/secrets.js';
import { DiskAssetSource } from '../../../src/runtimes/staging/disk.js';
import { TransferRules } from '../../../src/runtimes/staging/rules.js';
import type {
    ResolvedWorkbench,
    WorkbenchRequirements,
    WorkbenchRuntimeConfig,
} from '../../../src/types.js';

const temporaryDirectories: string[] = [];
export const disk = new DiskAssetSource();
export const rules = new TransferRules('Daytona');

/** Registers a directory for `cleanTemporaryDirectories`. */
export function track(directory: string): string {
    temporaryDirectories.push(directory);
    return directory;
}

export async function cleanTemporaryDirectories(): Promise<void> {
    await Promise.all(
        temporaryDirectories
            .splice(0)
            .map((directory) => rm(directory, { recursive: true, force: true }))
    );
}

/** A clock that never waits. It records every delay it was asked for. */
export class FakeClock implements DaytonaClock {
    readonly delays: number[] = [];

    constructor(public time = new Date('2026-09-30T12:00:00.000Z')) {}

    now(): Date {
        return this.time;
    }

    async sleep(milliseconds: number): Promise<void> {
        this.delays.push(milliseconds);
    }
}

/** A key and a connector that always hand back `client`. */
export function connection(client: DaytonaClient | undefined) {
    return {
        keys: client ? { key: () => 'fixture-key' } : RuntimeSecretStore,
        connector: {
            open: () => {
                if (!client) throw new Error('No Daytona client in this test');
                return client;
            },
        },
    };
}

/**
 * The provider as the registry wires it: disk files and disk transfer. With a
 * `client`, a fake connector hands it out for any key. Without one, the saved
 * key is looked up and no client can be opened.
 */
export function daytonaProvider({
    client,
    ...dependencies
}: Partial<DaytonaRuntimeDependencies> & { client?: DaytonaClient } = {}) {
    return new DaytonaRuntimeProvider({
        transfer: new DiskTransfer(disk, disk, rules),
        assets: disk,
        clock: new FakeClock(),
        ...connection(client),
        ...dependencies,
    });
}

export async function readFirstChunk(
    stream: ReadableStream<Uint8Array>
): Promise<string> {
    const reader = stream.getReader();
    const chunk = await reader.read();
    reader.releaseLock();
    return new TextDecoder().decode(chunk.value);
}

export class FakeClient implements DaytonaClient {
    readonly sandbox = new FakeSandbox();
    readonly createOptions: DaytonaCreateOptions[] = [];
    readonly deleted: string[] = [];
    /** Every delete attempt fails with this until `deleteFailures` have failed. */
    deleteFailure: Error | undefined;
    deleteFailures = Number.POSITIVE_INFINITY;
    deleteAttempts = 0;
    /** Daytona no longer knows the sandbox. */
    missing = false;

    async createSandbox(options: DaytonaCreateOptions): Promise<DaytonaSandbox> {
        this.createOptions.push(options);
        return this.sandbox;
    }

    async listSandboxes() {
        return [];
    }

    async getSandbox() {
        return this.missing ? undefined : this.sandbox;
    }

    async deleteSandbox(id: string): Promise<void> {
        this.deleteAttempts++;
        if (this.deleteFailure && this.deleteFailures > 0) {
            this.deleteFailures--;
            throw this.deleteFailure;
        }
        this.deleted.push(id);
    }
}

export class FakeSandbox implements DaytonaSandbox {
    readonly id = 'sandbox-fixture';
    readonly started: Array<{ command: string; options: RemoteCommandOptions }> = [];
    readonly runs: Array<{ command: string; options: RemoteRunOptions }> = [];
    readonly previews: Array<{ port: number; ttlSeconds: number }> = [];
    readonly uploads = new Map<string, Uint8Array>();
    readonly missingCommands = new Set<string>();
    readonly ownedDirectories = new Set<string>();
    rootUnavailable = false;
    /** What the next preview URL requests answer, in order, before the default. */
    previewAnswers: Array<Error | string> = [];
    artifactDownload: Uint8Array | undefined;
    installResult: { code: number; stdout: string; stderr: string } | undefined;
    nextRun: { code: number; stdout: string; stderr: string } | undefined;
    sandboxInfo: DaytonaSandboxInfo = { cpuCount: 1, memoryMB: 1_024, diskGb: 3 };
    uploadFailure: Error | undefined;
    holdProcesses = false;
    killedProcesses = 0;
    /** The state Daytona reports when the sandbox is looked up. */
    state: string | undefined;
    /** Whether the runner's server already accepts connections. */
    listening = false;
    probes = 0;
    baselineFailure = false;
    input = '';

    async run(command: string, options: RemoteRunOptions = {}) {
        this.runs.push({ command, options });
        if (this.nextRun && command.startsWith("'opencode'")) {
            const result = this.nextRun;
            this.nextRun = undefined;
            return result;
        }
        if (command === probeRepositoryTools) {
            const missing = ['git', 'gh'].filter((name) =>
                this.missingCommands.has(name)
            );
            return missing.length > 0 ? result(1, `${missing.join(' ')}\n`) : result(0);
        }
        if (command === installRepositoryTools) {
            if (this.installResult) return this.installResult;
            this.missingCommands.delete('git');
            this.missingCommands.delete('gh');
        }
        if (command === identityCommand) return result(0, '1000:1000');
        if (options.user === 'root' && command.includes('mkdir -p')) {
            return this.rootUnavailable
                ? result(1, '', 'root access is required')
                : result(0);
        }
        if (command.includes('mkdir -p') && command.includes('chmod 700')) {
            const targets = [...command.matchAll(/mkdir -p '([^']+)'/g)].map(
                (match) => match[1] as string
            );
            // Nested targets have a writable parent; targets under / need pre-owning.
            return targets.every(
                (path) => posix.dirname(path) !== '/' || this.ownedDirectories.has(path)
            )
                ? result(0)
                : result(1, '', 'Permission denied');
        }
        const ownership = [...command.matchAll(/test -O '([^']+)'/g)].map(
            (match) => match[1] as string
        );
        if (ownership.length > 0) {
            return ownership.every((path) => this.ownedDirectories.has(path))
                ? result(0)
                : result(1);
        }
        if (command === 'tar --help 2>&1') return result(0, '--null');
        if (command.startsWith('command -v')) {
            const name = command.match(/'([^']+)'/)?.[1] ?? 'tool';
            if (this.missingCommands.has(name)) return result(1);
            return result(0, `/usr/bin/${name}\n`);
        }
        if (command.includes('/dev/tcp') || command.includes('curl -s')) {
            this.probes += 1;
            return this.listening ? result(0) : result(1);
        }
        if (command.includes('rev-list --max-parents=0')) {
            return this.baselineFailure ? result(1) : result(0, `${'a'.repeat(40)}\n`);
        }
        if (command.includes('rev-parse HEAD')) return result(0, `${'a'.repeat(40)}\n`);
        return result(0);
    }

    async fileSize(path: string): Promise<number> {
        return this.remoteBytes(path).byteLength;
    }

    async start(command: string, options: RemoteCommandOptions = {}) {
        this.started.push({ command, options });
        await options.onStdout?.('streamed output');
        let release: (() => void) | undefined;
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });
        const process: RemoteCommand = {
            wait: async () => {
                if (this.holdProcesses) await held;
                return this.holdProcesses ? result(143) : result(0);
            },
            sendStdin: async (value) => {
                this.input +=
                    typeof value === 'string' ? value : new TextDecoder().decode(value);
            },
            closeStdin: async () => {},
            kill: async () => {
                this.killedProcesses++;
                release?.();
            },
        };
        return process;
    }

    async upload(path: string, data: Uint8Array): Promise<void> {
        if (this.uploadFailure) throw this.uploadFailure;
        this.uploads.set(path, data);
    }

    async download(path: string): Promise<ReadableStream<Uint8Array>> {
        return new Blob([this.remoteBytes(path)]).stream();
    }

    /** What the sandbox would hold at a collection path: unchanged input, no deletions. */
    private remoteBytes(path: string): Uint8Array {
        if (path.includes('workbench-artifacts')) {
            return this.artifactDownload ?? new Uint8Array();
        }
        const output = path.match(/workbench-output-(\d+)/)?.[1];
        if (output !== undefined) {
            return (
                this.uploads.get(`/tmp/workbench-input-${output}.tar.gz`) ??
                new Uint8Array()
            );
        }
        return new Uint8Array();
    }

    async previewUrl(port: number, ttlSeconds: number): Promise<string> {
        this.previews.push({ port, ttlSeconds });
        const answer = this.previewAnswers.shift();
        if (answer instanceof Error) throw answer;
        return answer ?? `https://${port}-token.proxy.daytona.test`;
    }

    async info(): Promise<DaytonaSandboxInfo> {
        return this.sandboxInfo;
    }
}

export function result(code: number, stdout = '', stderr = '') {
    return { code, stdout, stderr };
}

export async function fixture(
    overrides: {
        runtimes?: Record<string, WorkbenchRuntimeConfig>;
        requirements?: WorkbenchRequirements;
    } = {}
): Promise<ResolvedWorkbench> {
    const repository = track(
        await mkdtemp(join(tmpdir(), 'workbench-daytona-runtime-'))
    );
    const packageDirectory = join(repository, '.workbenches', 'daytona-fixture');
    await mkdir(packageDirectory, { recursive: true });
    const manifestPath = join(packageDirectory, 'workbench.yml');
    const instructionsPath = join(packageDirectory, 'instructions.md');
    await writeFile(manifestPath, 'fixture');
    await writeFile(instructionsPath, 'Use the fixture.');
    await writeFile(join(repository, 'source.txt'), 'baseline');
    return {
        manifestPath,
        packageDirectory,
        repositoryDirectory: repository,
        instructionsPath,
        skills: [],
        manifest: {
            spec: 1,
            version: '0.1.0',
            name: 'daytona-fixture',
            runner: 'opencode',
            model: { id: 'openai/gpt-5.6-terra' },
            instructions: './instructions.md',
            skills: [],
            tools: [],
            mcps: [],
            env: {},
            runtimes: overrides.runtimes ?? {
                daytona: { class: 'linux', image: 'ghcr.io/example/workbench:1.0.0' },
            },
            ...(overrides.requirements ? { requirements: overrides.requirements } : {}),
        },
    };
}

export function request(workbench: ResolvedWorkbench) {
    return {
        workbench,
        workspaceDirectory: workbench.repositoryDirectory,
        environment: { OPENAI_API_KEY: 'fixture-key' },
        assets: [
            { path: workbench.repositoryDirectory, access: 'read-write' as const },
            { path: workbench.packageDirectory, access: 'read-only' as const },
        ],
    };
}
