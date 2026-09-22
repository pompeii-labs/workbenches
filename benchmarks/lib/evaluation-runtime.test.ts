import { expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluationRuntimeScript } from './evaluation-runtime.ts';

test('evaluation helper preserves command arguments and omits provider credentials and actor assets', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-evaluation-test-'));
    try {
        const docker = join(dir, 'docker');
        writeFileSync(docker, '#!/bin/sh\nprintf "%s\\n" "$@"\n');
        chmodSync(docker, 0o700);
        const script = join(dir, 'runtime.sh');
        writeFileSync(
            script,
            evaluationRuntimeScript(
                'sha256:' + 'a'.repeat(64),
                '/tmp/a b',
                '/tmp/a b/project',
                false
            )
        );
        const run = Bun.spawnSync(
            ['sh', script, 'node', '-e', 'console.log("hello world")'],
            {
                env: {
                    PATH: dir + ':' + process.env.PATH,
                    OPENROUTER_API_KEY: 'not-a-real-secret',
                },
            }
        );
        expect(run.exitCode).toBe(0);
        const args = run.stdout.toString().trim().split('\n');
        expect(args.slice(-3)).toEqual(['node', '-e', 'console.log("hello world")']);
        expect(args).toContain('TMPDIR=/tmp');
        expect(args).toContain('/tmp/a b/project:/tmp/a b/project');
        expect(args).not.toContain('/tmp/a b:/tmp/a b');
        expect(args.join(' ')).not.toContain('OPENROUTER');
        expect(args.join(' ')).not.toContain('.workbenches');
        expect(args.join(' ')).not.toContain('docker.sock');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('evaluation helper rejects mutable image references', () => {
    expect(() =>
        evaluationRuntimeScript('latest', '/tmp/w', '/tmp/w/p', false)
    ).toThrow();
});
