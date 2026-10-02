import { describe, expect, test } from 'bun:test';

import { PreviewUrl } from '../../../src/runtimes/daytona/preview.js';
import { FakeClock, FakeSandbox } from './fixture.js';

describe('PreviewUrl', () => {
    test('asks once and shares the answer, including between concurrent calls', async () => {
        const sandbox = new FakeSandbox();
        const preview = new PreviewUrl(sandbox, 4096, new FakeClock());
        const [first, second] = await Promise.all([preview.get(600), preview.get(600)]);
        await preview.get(600);
        expect(first.href).toBe('https://4096-token.proxy.daytona.test/');
        expect(second).toBe(first);
        expect(sandbox.previews).toEqual([{ port: 4096, ttlSeconds: 600 }]);
    });

    test('retries a failed request with a growing delay', async () => {
        const sandbox = new FakeSandbox();
        sandbox.previewAnswers = [new Error('one'), new Error('two')];
        const clock = new FakeClock();
        const url = await new PreviewUrl(sandbox, 4096, clock).get(600);
        expect(url.hostname).toBe('4096-token.proxy.daytona.test');
        expect(sandbox.previews).toHaveLength(3);
        expect(clock.delays).toEqual([500, 1_000]);
    });

    test('gives up after four attempts and asks again on the next call', async () => {
        const sandbox = new FakeSandbox();
        sandbox.previewAnswers = [1, 2, 3, 4].map((n) => new Error(`failure ${n}`));
        const clock = new FakeClock();
        const preview = new PreviewUrl(sandbox, 4096, clock);
        await expect(preview.get(600)).rejects.toThrow('failure 4');
        expect(sandbox.previews).toHaveLength(4);
        expect(clock.delays).toEqual([500, 1_000, 2_000]);
        await expect(preview.get(600)).resolves.toBeInstanceOf(URL);
        expect(sandbox.previews).toHaveLength(5);
    });

    test('rejects a malformed URL without echoing it or retrying', async () => {
        const sandbox = new FakeSandbox();
        sandbox.previewAnswers = ['https://bad host/?token=signed-secret'];
        const clock = new FakeClock();
        const error = await new PreviewUrl(sandbox, 4096, clock)
            .get(600)
            .catch((value) => value);
        expect(error.name).toBe('RuntimeError');
        expect(error.message).toBe('Daytona returned a malformed preview URL');
        expect(error.message).not.toContain('signed-secret');
        expect(sandbox.previews).toHaveLength(1);
        expect(clock.delays).toEqual([]);
    });
});
