import { afterEach, describe, expect, test } from 'bun:test';

import { DaytonaApi } from '../../src/runtimes/daytona/api.js';
import type { DaytonaSandbox } from '../../src/runtimes/daytona/contracts.js';

/**
 * Opt-in: creates real Daytona sandboxes and spends Daytona usage. Run with
 * `DAYTONA_E2E=1 DAYTONA_API_KEY=... bun run test:daytona`.
 */
const enabled =
    process.env.DAYTONA_E2E === '1' && Boolean(process.env.DAYTONA_API_KEY?.trim());

const label = `e2e-${crypto.randomUUID()}`;
const labels = { 'dev.workbenches.e2e': label };
const created: string[] = [];

function client(): DaytonaApi {
    return new DaytonaApi({
        apiKey: process.env.DAYTONA_API_KEY ?? '',
        fetch,
        ...(process.env.DAYTONA_API_URL?.trim()
            ? { apiUrl: process.env.DAYTONA_API_URL }
            : {}),
    });
}

async function createSandbox(): Promise<DaytonaSandbox> {
    const sandbox = await client().createSandbox({
        image: 'debian:bookworm-slim',
        labels,
        leaseMinutes: 15,
    });
    created.push(sandbox.id);
    return sandbox;
}

afterEach(async () => {
    const api = client();
    await Promise.allSettled(created.splice(0).map((id) => api.deleteSandbox(id)));
});

describe.skipIf(!enabled)('Daytona runtime end to end', () => {
    test(
        'creates a sandbox, runs a command, transfers a file, and deletes it',
        async () => {
            const api = client();
            const sandbox = await createSandbox();

            const echoed = await sandbox.run('echo hello-from-daytona');
            expect(echoed.code).toBe(0);
            expect(echoed.stdout).toContain('hello-from-daytona');

            const payload = new TextEncoder().encode(`payload ${label}`);
            await sandbox.upload('/tmp/wb-e2e.txt', payload);
            const uploaded = await sandbox.run('cat /tmp/wb-e2e.txt');
            expect(uploaded.stdout).toBe(`payload ${label}`);
            const downloaded = new Uint8Array(
                await new Response(
                    await sandbox.download('/tmp/wb-e2e.txt')
                ).arrayBuffer()
            );
            expect(new TextDecoder().decode(downloaded)).toBe(`payload ${label}`);

            expect(
                (await api.listSandboxes(labels)).map((entry) => entry.id)
            ).toContain(sandbox.id);

            await api.deleteSandbox(sandbox.id);
            created.splice(created.indexOf(sandbox.id), 1);

            // Deletion is eventually consistent. Poll the label listing until
            // nothing live is left under this run's label.
            let remaining = await liveUnderLabel(api);
            for (let attempt = 0; remaining.length > 0 && attempt < 30; attempt++) {
                await Bun.sleep(2_000);
                remaining = await liveUnderLabel(api);
            }
            expect(remaining).toEqual([]);
        },
        { timeout: 15 * 60_000 }
    );

    test(
        'streams a background command and issues a preview URL',
        async () => {
            const sandbox = await createSandbox();
            const out: string[] = [];
            const command = await sandbox.start('echo first; sleep 1; echo second', {
                onStdout: (data) => void out.push(data),
            });
            const result = await command.wait();
            expect(result.code).toBe(0);
            expect(out.join('')).toContain('first');
            expect(out.join('')).toContain('second');

            const url = await sandbox.previewUrl(4096, 600);
            expect(new URL(url).protocol).toBe('https:');
        },
        { timeout: 15 * 60_000 }
    );
});

async function liveUnderLabel(api: DaytonaApi) {
    return (await api.listSandboxes(labels)).filter(
        (entry) => entry.state !== 'destroyed'
    );
}
