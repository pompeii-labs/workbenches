import { expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const policy = join(import.meta.dir, 'docker-policy.sh');

async function invoke(args: string[], network = 'host') {
    const directory = mkdtempSync(join(tmpdir(), 'workbenchmark-policy-'));
    const fake = join(directory, 'docker-real');
    writeFileSync(
        fake,
        `#!/usr/bin/env bash\nif [[ "$1" == inspect ]]; then printf '${network}\\n'; else printf '%s\\n' "$@"; fi\n`
    );
    chmodSync(fake, 0o755);
    try {
        const child = Bun.spawn(['bash', policy, ...args], {
            env: { ...process.env, DOCKER_REAL: fake },
            stdout: 'pipe',
            stderr: 'pipe',
        });
        return {
            code: await child.exited,
            stdout: await new Response(child.stdout).text(),
            stderr: await new Response(child.stderr).text(),
        };
    } finally {
        // The process has completed before this finally executes because its output is awaited.
        rmSync(directory, { recursive: true, force: true });
    }
}

test('adapter makes engine bridge runners share the private daemon network', async () => {
    const result = await invoke(['run', '--network', 'bridge', 'alpine:3.22']);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('run\n--network\nhost\nalpine:3.22\n');
});

test('adapter leaves explicit none networking unchanged', async () => {
    const result = await invoke(['run', '--network', 'none', 'alpine:3.22']);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('run\n--network\nnone\nalpine:3.22\n');
});

test('adapter preserves published-port bridge runners', async () => {
    const result = await invoke([
        'run',
        '--network',
        'bridge',
        '--publish',
        '127.0.0.1:4545:4545',
        'alpine:3.22',
    ]);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(
        'run\n--network\nhost\n--publish\n127.0.0.1:4545:4545\nalpine:3.22\n'
    );
});

test('adapter resolves host-network ports without a published mapping', async () => {
    const result = await invoke(['port', 'runner', '5432/tcp']);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('127.0.0.1:5432\n');
});

test('adapter passes bridge-network port lookup through unchanged', async () => {
    const result = await invoke(['port', 'runner', '5432/tcp'], 'bridge');
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('port\nrunner\n5432/tcp\n');
});
