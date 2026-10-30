import { afterEach, describe, expect, test } from 'bun:test';
import type { RuntimePreview } from '../../src/runtimes/contracts.js';
import { DaytonaApi } from '../../src/runtimes/daytona/api.js';
import type { DaytonaSandbox } from '../../src/runtimes/daytona/contracts.js';
import { SandboxPreviews } from '../../src/runtimes/daytona/previews.js';
import { SandboxSnapshot } from '../../src/runtimes/daytona/snapshots.js';
import { TransferRules } from '../../src/runtimes/staging/rules.js';

/**
 * Opt-in: creates real Daytona sandboxes from a shared snapshot of
 * `debian:bookworm-slim`, which is left in place for later runs, and spends
 * Daytona usage. Run with
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
    const api = client();
    const snapshot = await new SandboxSnapshot(api, {
        now: () => new Date(),
        sleep: (milliseconds) => Bun.sleep(milliseconds),
    }).ready('debian:bookworm-slim', { gpu: false });
    const sandbox = await api.createSandbox({
        snapshot,
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

    test(
        'follows a wbx announcement over the log stream and signs a URL for it',
        async () => {
            const sandbox = await createSandbox();
            const previews = new SandboxPreviews(
                sandbox,
                new TransferRules('Daytona'),
                () => [4096, 2280, 22222, 33333]
            );
            await previews.install();
            const published: RuntimePreview[] = [];
            const warnings: string[] = [];
            previews.watch({
                available: async (preview) => {
                    published.push(preview);
                },
                warn: (message) => warnings.push(message),
            });
            const server = await sandbox.run(
                "nohup perl -MIO::Socket::INET -e '$s=IO::Socket::INET->new(LocalAddr=>q(127.0.0.1),LocalPort=>8080,Listen=>5,ReuseAddr=>1) or die; while($c=$s->accept){print $c qq(HTTP/1.0 200 OK\\r\\n\\r\\nwbx-preview-ok); close $c}' >/dev/null 2>&1 &"
            );
            expect(server.code).toBe(0);
            await Bun.sleep(1_000);
            const announced = await sandbox.run(
                previews.command('wbx preview 8080 --name demo')
            );
            expect(announced.stdout).toContain(
                'wbx: announced preview demo on port 8080'
            );
            // The follower delivers the announcement without a turn-end read.
            for (let attempt = 0; published.length === 0 && attempt < 60; attempt++) {
                await Bun.sleep(500);
            }
            expect(published).toEqual([{ name: 'demo', port: 8080 }]);
            expect(warnings).toEqual([]);

            const signed = await previews.signedUrl(8080, 120);
            const page = await fetch(signed.url, {
                headers: { 'X-Daytona-Skip-Preview-Warning': 'true' },
            });
            expect(await page.text()).toContain('wbx-preview-ok');
            await previews.expire(8080, signed.token);
            await expect(previews.signedUrl(4096, 120)).rejects.toThrow(
                'Port 4096 is not a preview this run announced'
            );
            await previews.close();
        },
        { timeout: 15 * 60_000 }
    );
});

async function liveUnderLabel(api: DaytonaApi) {
    return (await api.listSandboxes(labels)).filter(
        (entry) => entry.state !== 'destroyed'
    );
}
