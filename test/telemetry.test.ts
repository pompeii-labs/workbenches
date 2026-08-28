import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RegistryTelemetry } from '../src/registry/index.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories
            .splice(0)
            .map((directory) => rm(directory, { recursive: true, force: true }))
    );
});

describe('anonymous registry counters', () => {
    test('reports the exact immutable version without execution content', async () => {
        let request: Request | undefined;
        const telemetry = new RegistryTelemetry({
            fetch: async (input, init) => {
                request =
                    input instanceof Request
                        ? new Request(input, init)
                        : new Request(
                              input instanceof URL ? input.toString() : input,
                              init
                          );
                return Response.json({ accepted: true }, { status: 202 });
            },
        });
        const accepted = await telemetry.report({
            registry: {
                url: 'https://api.workbenches.dev',
                publisher: 'example',
                workbench: 'core',
                version_id: '08f3e3ef-4c2c-4b1e-b0fd-b4ca2b6fda11',
            },
            kind: 'run',
            idempotencyKey: '78c4bf29-7b13-48bb-a2f8-95e933fd03dc',
        });

        expect(accepted).toBeTrue();
        expect(request?.url).toBe('https://api.workbenches.dev/v1/events');
        const body = await request?.json();
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
            throw new Error('Expected an event request body');
        }
        expect(body).toMatchObject({
            idempotency_key: '78c4bf29-7b13-48bb-a2f8-95e933fd03dc',
            version_id: '08f3e3ef-4c2c-4b1e-b0fd-b4ca2b6fda11',
            kind: 'run',
        });
        expect(Object.keys(body).sort()).toEqual([
            'cli_version',
            'idempotency_key',
            'kind',
            'occurred_at',
            'version_id',
        ]);
    });

    test('never turns a failed counter request into a CLI failure', async () => {
        expect(
            await new RegistryTelemetry({
                fetch: async () => {
                    throw new Error('offline');
                },
            }).report({
                registry: {
                    url: 'https://api.workbenches.dev',
                    publisher: 'example',
                    workbench: 'core',
                    version_id: '08f3e3ef-4c2c-4b1e-b0fd-b4ca2b6fda11',
                },
                kind: 'save',
            })
        ).toBeFalse();
    });

    test('persists run reporting preference and honors standard opt-outs', async () => {
        const home = await temporaryHome();
        const telemetry = new RegistryTelemetry({ home, environment: {} });
        expect(await telemetry.enabled()).toBeTrue();
        await telemetry.setEnabled(false);
        expect(await telemetry.enabled()).toBeFalse();
        await telemetry.setEnabled(true);
        expect(
            await new RegistryTelemetry({
                home,
                environment: { DO_NOT_TRACK: '1' },
            }).enabled()
        ).toBeFalse();
        expect(
            await new RegistryTelemetry({
                home,
                environment: { WB_TELEMETRY_DISABLED: '1' },
            }).enabled()
        ).toBeFalse();
    });
});

async function temporaryHome(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'workbench-telemetry-'));
    temporaryDirectories.push(directory);
    return directory;
}
