import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportNativeTrace } from './trace.ts';

test('large native exports survive a CLI that exits before stdout pipes drain', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-trace-export-test-'));
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    const oldPath = process.env.PATH;
    try {
        writeFileSync(
            join(bin, 'opencode'),
            '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({messages:[{parts:[{type:"tool",tool:"bash",state:{status:"completed",output:"x".repeat(2_000_000)}}]}]}));process.exit(0);\n',
            { mode: 0o700 }
        );
        process.env.PATH = `${bin}:${oldPath}`;
        const result = JSON.parse(
            await exportNativeTrace(dir, 'plain', 'ses_synthetic')
        );
        expect(result.tools[0].output.length).toBe(2_000_000);
        expect(result.tools[0].name).toBe('bash');
    } finally {
        process.env.PATH = oldPath;
        rmSync(dir, { recursive: true, force: true });
    }
});
