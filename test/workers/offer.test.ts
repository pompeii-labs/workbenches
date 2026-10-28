import { describe, expect, test } from 'bun:test';

import { WorkerRuntimeOffer } from '../../src/workers/offer.js';

function offer(docker: string | undefined) {
    const checked: string[] = [];
    return {
        checked,
        offer: new WorkerRuntimeOffer({
            machine: {
                docker: async () => {
                    checked.push('docker');
                    return docker;
                },
            },
        }),
    };
}

describe('the runtimes a worker offers', () => {
    test('are local, and docker while Docker is reachable', async () => {
        expect(await offer('27.3.1').offer.check(['docker', 'local'])).toEqual({
            runtimes: ['docker', 'local'],
        });
        expect(await offer(undefined).offer.check(['docker', 'local'])).toEqual({
            runtimes: ['local'],
        });
        expect(await offer(undefined).offer.check(['docker'])).toEqual({
            runtimes: [],
        });
    });

    test('are only narrowed by --runtimes, never widened', async () => {
        const local = offer('27.3.1');
        expect(await local.offer.check(['local'])).toEqual({ runtimes: ['local'] });
        expect(local.checked).toEqual([]);
    });
});
