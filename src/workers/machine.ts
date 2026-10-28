import { RunnerRegistry } from '../runners/registry.js';
import { GpuDiscovery } from '../workbench/gpus.js';
import { NodeHost } from '../workbench/host.js';
import type { WorkerMachine } from './protocol.js';

/** Runs a short command and returns its trimmed standard output, or undefined on failure. */
export type WorkerProbeCommand = (command: string[]) => Promise<string | undefined>;

export interface WorkerMachineDependencies {
    command?: WorkerProbeCommand;
    which?: (name: string) => string | null;
    runners?: Pick<RunnerRegistry, 'list'>;
    host?: Pick<NodeHost, 'describe'>;
    gpus?: Pick<GpuDiscovery, 'discover'>;
}

/**
 * Describes this machine for `hello`: hardware, GPUs, Docker, and the runner
 * CLIs on `PATH`. GPUs are discovered on every `hello`, so a driver that
 * loads after the worker starts is seen on the next connection.
 */
export class WorkerMachineProbe {
    readonly #command: WorkerProbeCommand;
    readonly #which: (name: string) => string | null;
    readonly #runners: Pick<RunnerRegistry, 'list'>;
    readonly #host: Pick<NodeHost, 'describe'>;
    readonly #gpus: Pick<GpuDiscovery, 'discover'>;

    constructor(dependencies: WorkerMachineDependencies = {}) {
        this.#command = dependencies.command ?? probe;
        this.#which = dependencies.which ?? ((name) => Bun.which(name));
        this.#runners = dependencies.runners ?? RunnerRegistry.standard();
        this.#host = dependencies.host ?? new NodeHost();
        this.#gpus = dependencies.gpus ?? new GpuDiscovery();
    }

    /** The Docker server version, or undefined when Docker is not running. */
    async docker(): Promise<string | undefined> {
        if (!this.#which('docker')) return undefined;
        const version = await this.#command([
            'docker',
            'version',
            '--format',
            '{{.Server.Version}}',
        ]);
        return version || undefined;
    }

    /**
     * The endpoint of the account's current Docker context, such as Docker
     * Desktop's socket. Runs reach the daemon through it with a client
     * configuration of their own, which has no contexts.
     */
    async dockerHost(): Promise<string | undefined> {
        if (!this.#which('docker')) return undefined;
        const endpoint = await this.#command([
            'docker',
            'context',
            'inspect',
            '--format',
            '{{(index .Endpoints "docker").Host}}',
        ]);
        return endpoint || undefined;
    }

    async describe(): Promise<WorkerMachine> {
        const host = this.#host.describe();
        const [docker, gpus] = await Promise.all([
            this.docker(),
            this.#gpus.discover(),
        ]);
        const runners = await Promise.all(
            this.#runners.list().map(async (runner) => {
                const executable = this.#which(runner.executable);
                if (!executable) return undefined;
                const output = await this.#command([executable, '--version']);
                const version = output?.split('\n')[0]?.trim();
                return { name: runner.name, version: version || 'unknown' };
            })
        );
        return {
            os: host.os,
            arch: host.arch,
            cpus: host.cpus,
            memory_gb: Math.round((host.memoryBytes / 1024 ** 3) * 10) / 10,
            gpus: gpus.gpus,
            docker: docker ? { version: docker } : null,
            runners: runners.filter((runner) => runner !== undefined),
        };
    }
}

export async function probe(command: string[]): Promise<string | undefined> {
    try {
        const child = Bun.spawn(command, {
            stdin: 'ignore',
            stdout: 'pipe',
            stderr: 'ignore',
        });
        const timer = setTimeout(() => child.kill(), 10_000);
        try {
            const output = await new Response(child.stdout).text();
            return (await child.exited) === 0 ? output.trim() : undefined;
        } finally {
            clearTimeout(timer);
        }
    } catch {
        return undefined;
    }
}
