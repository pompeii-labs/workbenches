import { describe, expect, test } from 'bun:test';

import {
    GpuDiscovery,
    type GpuProbeCommand,
    parseNvidiaSmi,
    parseSystemProfiler,
} from '../../src/workbench/gpus.js';
import { NodeHost } from '../../src/workbench/host.js';

/** `nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits` on a three GPU host. */
const NVIDIA_SMI_THREE = [
    'NVIDIA GeForce RTX 4090, 24564',
    'NVIDIA GeForce RTX 4090, 24564',
    'NVIDIA RTX A6000, 49140',
    '',
].join('\n');

/** `system_profiler SPDisplaysDataType -json` on an Apple Silicon Mac, with its displays trimmed. */
const SYSTEM_PROFILER_APPLE = JSON.stringify({
    SPDisplaysDataType: [
        {
            _name: 'Apple M2 Max',
            spdisplays_mtlgpufamilysupport: 'spdisplays_metal4',
            spdisplays_ndrvs: [
                {
                    _name: 'Color LCD',
                    spdisplays_connection_type: 'spdisplays_internal',
                    spdisplays_main: 'spdisplays_yes',
                },
            ],
            spdisplays_vendor: 'sppci_vendor_Apple',
            sppci_bus: 'spdisplays_builtin',
            sppci_cores: '30',
            sppci_device_type: 'spdisplays_gpu',
            sppci_model: 'Apple M2 Max',
        },
    ],
});

function discovery(
    platform: string,
    installed: string[],
    reply: Awaited<ReturnType<GpuProbeCommand>>,
    ran: string[][] = []
): GpuDiscovery {
    return new GpuDiscovery({
        platform,
        which: (name) => (installed.includes(name) ? `/usr/bin/${name}` : null),
        command: async (command) => {
            ran.push(command);
            return reply;
        },
    });
}

describe('GPU discovery', () => {
    test('reports three NVIDIA GPUs with their memory in GiB', async () => {
        const ran: string[][] = [];
        const inventory = await discovery(
            'linux',
            ['nvidia-smi'],
            { code: 0, stdout: NVIDIA_SMI_THREE, stderr: '' },
            ran
        ).discover();
        expect(ran).toEqual([
            [
                '/usr/bin/nvidia-smi',
                '--query-gpu=name,memory.total',
                '--format=csv,noheader,nounits',
            ],
        ]);
        expect(inventory).toEqual({
            gpus: [
                { name: 'NVIDIA GeForce RTX 4090', memory_gb: 24 },
                { name: 'NVIDIA GeForce RTX 4090', memory_gb: 24 },
                { name: 'NVIDIA RTX A6000', memory_gb: 48 },
            ],
        });
    });

    test('finds none, and says why, when nvidia-smi sees no GPU', async () => {
        expect(
            await discovery('linux', ['nvidia-smi'], {
                code: 6,
                stdout: 'No devices were found\n',
                stderr: '',
            }).discover()
        ).toEqual({
            gpus: [],
            reason: 'nvidia-smi exited with 6: No devices were found',
        });
        expect(
            await discovery('linux', ['nvidia-smi'], {
                code: 0,
                stdout: '',
                stderr: '',
            }).discover()
        ).toEqual({ gpus: [], reason: 'nvidia-smi lists no GPU' });
    });

    test('finds none, and never throws, when nvidia-smi is missing or cannot start', async () => {
        const ran: string[][] = [];
        expect(
            await discovery(
                'linux',
                [],
                { code: 0, stdout: '', stderr: '' },
                ran
            ).discover()
        ).toEqual({ gpus: [], reason: 'nvidia-smi is not installed' });
        expect(ran).toEqual([]);
        expect(await discovery('linux', ['nvidia-smi'], undefined).discover()).toEqual({
            gpus: [],
            reason: 'nvidia-smi could not be started',
        });
    });

    test('reports an Apple Silicon GPU from system_profiler without memory', async () => {
        const ran: string[][] = [];
        const inventory = await discovery(
            'darwin',
            ['system_profiler'],
            { code: 0, stdout: SYSTEM_PROFILER_APPLE, stderr: '' },
            ran
        ).discover();
        expect(ran).toEqual([
            ['/usr/bin/system_profiler', 'SPDisplaysDataType', '-json'],
        ]);
        expect(inventory).toEqual({ gpus: [{ name: 'Apple M2 Max' }] });
    });

    test('finds none on a platform it cannot query', async () => {
        expect(
            await discovery('win32', [], { code: 0, stdout: '', stderr: '' }).discover()
        ).toEqual({ gpus: [], reason: 'GPU discovery is not supported on win32' });
    });

    test('keeps reports inside the shape the server accepts', () => {
        const long = 'G'.repeat(300);
        const many = Array.from({ length: 70 }, () => `${long}, [N/A]`).join('\n');
        const gpus = parseNvidiaSmi(many);
        expect(gpus[0]).toEqual({ name: 'G'.repeat(200) });
        expect(parseNvidiaSmi(', 1024\nnot a row\n')).toEqual([]);
        expect(parseSystemProfiler('not json')).toEqual([]);
        expect(
            parseSystemProfiler(
                JSON.stringify({
                    SPDisplaysDataType: [
                        {
                            _name: 'Display only',
                            sppci_device_type: 'spdisplays_display',
                        },
                        { _name: 'Fallback name' },
                    ],
                })
            )
        ).toEqual([{ name: 'Fallback name' }]);
    });

    test('caps discovery at 64 GPUs', async () => {
        const stdout = Array.from(
            { length: 70 },
            (_, index) => `GPU ${index}, 1024`
        ).join('\n');
        const inventory = await discovery('linux', ['nvidia-smi'], {
            code: 0,
            stdout,
            stderr: '',
        }).discover();
        expect(inventory.gpus).toHaveLength(64);
    });

    test('a node host discovers once and reuses the answer', async () => {
        let calls = 0;
        const host = new NodeHost({
            discover: async () => {
                calls += 1;
                return { gpus: [{ name: 'Apple M2 Max' }] };
            },
        });
        await host.gpus();
        expect(await host.gpus()).toEqual({ gpus: [{ name: 'Apple M2 Max' }] });
        expect(calls).toBe(1);
    });
});
