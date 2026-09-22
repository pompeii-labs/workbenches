import { expect, test } from 'bun:test';
import {
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    statSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { retainGradingArtifacts } from './grading-artifacts.ts';

test('retains nested screenshots, probes and metadata after source cleanup', () => {
    const root = mkdtempSync(join(tmpdir(), 'wbm-evidence-'));
    try {
        const source = join(root, 'source'),
            evidence = join(root, 'evidence');
        mkdirSync(join(source, 'screenshots'), { recursive: true });
        const png = Buffer.from([137, 80, 78, 71, 0, 1, 2, 255]);
        writeFileSync(join(source, 'screenshots', 'completed.png'), png);
        writeFileSync(join(source, 'browser-report.json'), '{"completed":true}');
        const manifest = retainGradingArtifacts(source, evidence);
        rmSync(source, { recursive: true });
        expect(
            readFileSync(join(evidence, 'artifacts', 'screenshots', 'completed.png'))
        ).toEqual(png);
        expect(manifest.files).toHaveLength(2);
        expect(manifest.files.every((f) => /^[0-9a-f]{64}$/.test(f.sha256))).toBe(true);
        expect(
            statSync(join(evidence, 'artifacts', 'browser-report.json')).mode & 0o777
        ).toBe(0o600);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('does not traverse links or retain dependency and credential files', () => {
    const root = mkdtempSync(join(tmpdir(), 'wbm-evidence-'));
    try {
        const source = join(root, 'source');
        mkdirSync(join(source, 'node_modules'), { recursive: true });
        writeFileSync(join(root, 'outside'), 'private');
        symlinkSync(join(root, 'outside'), join(source, 'link'));
        writeFileSync(join(source, '.env'), 'KEY=private');
        writeFileSync(join(source, 'auth.json'), 'private');
        writeFileSync(join(source, 'node_modules', 'dep.js'), 'large dependency');
        const manifest = retainGradingArtifacts(source, join(root, 'evidence'));
        expect(manifest.files).toHaveLength(0);
        expect(manifest.skipped).toHaveLength(4);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('redacts inherited keys and bearer tokens and omits credential-bearing binary files', () => {
    const root = mkdtempSync(join(tmpdir(), 'wbm-evidence-'));
    try {
        const source = join(root, 'source'),
            evidence = join(root, 'evidence');
        mkdirSync(source);
        writeFileSync(
            join(source, 'probe.log'),
            'custom-private-key Bearer session-token sk-example-secret'
        );
        writeFileSync(
            join(source, 'unsafe.bin'),
            Buffer.from('binary\0custom-private-key')
        );
        const manifest = retainGradingArtifacts(source, evidence, [
            'custom-private-key',
        ]);
        expect(readFileSync(join(evidence, 'artifacts', 'probe.log'), 'utf8')).toBe(
            '[REDACTED] Bearer [REDACTED] [REDACTED]'
        );
        expect(manifest.files[0]?.redacted).toBe(true);
        expect(manifest.skipped[0]?.reason).toBe('credential-bearing-binary');
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
