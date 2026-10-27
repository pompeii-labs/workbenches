/** One GPU of this machine. */
export interface HostGpu {
    /** The model name, 1 to 200 characters. */
    name: string;
    /** Dedicated memory in GiB. Absent for a GPU that shares system memory, such as Apple's. */
    memory_gb?: number;
}

/** What GPU discovery found on this machine. */
export interface GpuInventory {
    gpus: HostGpu[];
    /** Why discovery found no GPU, such as a missing nvidia-smi. Only present when `gpus` is empty. */
    reason?: string;
}

/** Runs a short command: its exit code and output, or undefined when it cannot start. */
export type GpuProbeCommand = (
    command: string[]
) => Promise<{ code: number; stdout: string; stderr: string } | undefined>;

export interface GpuDiscoveryDependencies {
    platform?: string;
    which?: (name: string) => string | null;
    command?: GpuProbeCommand;
}

/** At most this many GPUs are reported, and each name is cut to this length. */
const MAXIMUM_GPUS = 64;
const MAXIMUM_NAME = 200;

/**
 * Finds this machine's GPUs: NVIDIA GPUs through nvidia-smi on Linux, and
 * the GPUs system_profiler lists on macOS. A missing tool or a failed command
 * finds none and names why, and never throws.
 */
export class GpuDiscovery {
    readonly #platform: string;
    readonly #which: (name: string) => string | null;
    readonly #command: GpuProbeCommand;

    constructor(dependencies: GpuDiscoveryDependencies = {}) {
        this.#platform = dependencies.platform ?? process.platform;
        this.#which = dependencies.which ?? ((name) => Bun.which(name));
        this.#command = dependencies.command ?? probe;
    }

    async discover(): Promise<GpuInventory> {
        if (this.#platform === 'linux')
            return this.#query(
                'nvidia-smi',
                ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'],
                parseNvidiaSmi
            );
        if (this.#platform === 'darwin')
            return this.#query(
                'system_profiler',
                ['SPDisplaysDataType', '-json'],
                parseSystemProfiler
            );
        return {
            gpus: [],
            reason: `GPU discovery is not supported on ${this.#platform}`,
        };
    }

    async #query(
        tool: string,
        args: string[],
        parse: (output: string) => HostGpu[]
    ): Promise<GpuInventory> {
        const executable = this.#which(tool);
        if (!executable) return { gpus: [], reason: `${tool} is not installed` };
        const result = await this.#command([executable, ...args]);
        if (!result) return { gpus: [], reason: `${tool} could not be started` };
        if (result.code !== 0) {
            // nvidia-smi prints "No devices were found" and NVML errors on stdout.
            const detail = `${result.stdout}\n${result.stderr}`
                .split('\n')
                .map((line) => line.trim())
                .find(Boolean);
            return {
                gpus: [],
                reason: `${tool} exited with ${result.code}${detail ? `: ${detail.slice(0, MAXIMUM_NAME)}` : ''}`,
            };
        }
        const gpus = parse(result.stdout).slice(0, MAXIMUM_GPUS);
        return gpus.length ? { gpus } : { gpus, reason: `${tool} lists no GPU` };
    }
}

/** Parses `nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits`, whose memory is in MiB. */
export function parseNvidiaSmi(output: string): HostGpu[] {
    return output.split('\n').flatMap((line) => {
        const separator = line.lastIndexOf(',');
        if (separator < 0) return [];
        const name = gpuName(line.slice(0, separator));
        if (!name) return [];
        const mebibytes = Number(line.slice(separator + 1).trim());
        return [
            Number.isFinite(mebibytes) && mebibytes >= 0
                ? { name, memory_gb: Math.round((mebibytes / 1024) * 10) / 10 }
                : { name },
        ];
    });
}

/** Parses `system_profiler SPDisplaysDataType -json`. Apple GPUs share system memory, so none is reported. */
export function parseSystemProfiler(output: string): HostGpu[] {
    let value: unknown;
    try {
        value = JSON.parse(output);
    } catch {
        return [];
    }
    const entries: unknown =
        typeof value === 'object' && value !== null
            ? Reflect.get(value, 'SPDisplaysDataType')
            : undefined;
    if (!Array.isArray(entries)) return [];
    return entries.flatMap((entry: unknown) => {
        if (typeof entry !== 'object' || entry === null) return [];
        const type: unknown = Reflect.get(entry, 'sppci_device_type');
        if (type !== undefined && type !== 'spdisplays_gpu') return [];
        const model: unknown = Reflect.get(entry, 'sppci_model');
        const fallback: unknown = Reflect.get(entry, '_name');
        const name = gpuName(
            typeof model === 'string'
                ? model
                : typeof fallback === 'string'
                  ? fallback
                  : ''
        );
        return name ? [{ name }] : [];
    });
}

function gpuName(text: string): string {
    return text.trim().slice(0, MAXIMUM_NAME).trim();
}

async function probe(command: string[]): ReturnType<GpuProbeCommand> {
    try {
        const child = Bun.spawn(command, {
            stdin: 'ignore',
            stdout: 'pipe',
            stderr: 'pipe',
        });
        const timer = setTimeout(() => child.kill(), 10_000);
        try {
            const [code, stdout, stderr] = await Promise.all([
                child.exited,
                new Response(child.stdout).text(),
                new Response(child.stderr).text(),
            ]);
            return { code, stdout, stderr };
        } finally {
            clearTimeout(timer);
        }
    } catch {
        return undefined;
    }
}
