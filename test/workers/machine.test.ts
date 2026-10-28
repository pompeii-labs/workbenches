import { describe, expect, test } from 'bun:test';

import { RunnerRegistry } from '../../src/runners/registry.js';
import { GpuDiscovery } from '../../src/workbench/gpus.js';
import { WorkerMachineProbe } from '../../src/workers/machine.js';
import {
    WORKER_PROTOCOL,
    type WorkerMachine,
    type WorkerMessage,
} from '../../src/workers/protocol.js';

/** A Linux worker with three NVIDIA GPUs, nvidia-smi output as recorded. */
function probe(nvidiaSmi: string | undefined): WorkerMachineProbe {
    return new WorkerMachineProbe({
        which: (name) => (name === 'opencode' ? '/usr/bin/opencode' : null),
        command: async () => '1.18.30',
        runners: RunnerRegistry.standard(),
        host: {
            describe: () => ({
                os: 'linux',
                arch: 'x64',
                cpus: 32,
                memoryBytes: 128 * 1024 ** 3,
            }),
        },
        gpus: new GpuDiscovery({
            platform: 'linux',
            which: (name) =>
                name === 'nvidia-smi' && nvidiaSmi !== undefined
                    ? '/usr/bin/nvidia-smi'
                    : null,
            command: async () => ({ code: 0, stdout: nvidiaSmi ?? '', stderr: '' }),
        }),
    });
}

describe('worker machine', () => {
    test('says hello with each GPU as a name and its memory', async () => {
        const machine = await probe(
            [
                'NVIDIA H100 80GB HBM3, 81559',
                'NVIDIA H100 80GB HBM3, 81559',
                'NVIDIA L4, 23034',
                '',
            ].join('\n')
        ).describe();
        expect(machine).toEqual({
            os: 'linux',
            arch: 'x64',
            cpus: 32,
            memory_gb: 128,
            gpus: [
                { name: 'NVIDIA H100 80GB HBM3', memory_gb: 79.6 },
                { name: 'NVIDIA H100 80GB HBM3', memory_gb: 79.6 },
                { name: 'NVIDIA L4', memory_gb: 22.5 },
            ],
            docker: null,
            runners: [{ name: 'opencode', version: '1.18.30' }],
        });
        const hello: WorkerMessage = {
            type: 'hello',
            protocol: WORKER_PROTOCOL,
            wb_version: '1.4.0',
            machine,
            runtimes: ['local'],
            slots: 1,
            runs: [],
        };
        const sent: unknown = JSON.parse(JSON.stringify(hello));
        expect(sent).toMatchObject({
            machine: {
                gpus: [{ name: 'NVIDIA H100 80GB HBM3', memory_gb: 79.6 }, {}, {}],
            },
        });
    });

    test('says hello with no GPUs where nvidia-smi is missing', async () => {
        const machine: WorkerMachine = await probe(undefined).describe();
        expect(machine.gpus).toEqual([]);
    });
});
