import { createHash } from 'node:crypto';
import {
    lstatSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

/** Preserve private probe evidence before the disposable grading tree is removed. */
export function retainGradingArtifacts(
    source: string,
    evidence: string,
    secrets: string[] = []
) {
    const destination = join(evidence, 'artifacts');
    const files: { path: string; bytes: number; sha256: string; redacted: boolean }[] =
        [];
    const skipped: { path: string; reason: string }[] = [];
    let bytes = 0;
    const credentials = secrets.filter(Boolean);
    mkdirSync(destination, { recursive: true, mode: 0o700 });
    const visit = (directory: string, prefix = '') => {
        for (const entry of readdirSync(directory, { withFileTypes: true }).sort(
            (a, b) => a.name.localeCompare(b.name)
        )) {
            const name = prefix + entry.name;
            const path = join(directory, entry.name);
            if (entry.isSymbolicLink()) {
                skipped.push({ path: name, reason: 'symlink' });
                continue;
            }
            if (
                ['node_modules', '.git', '.cache', 'browser-profile'].includes(
                    entry.name
                ) ||
                /^\.env(?:\.|$)/.test(entry.name) ||
                /^(?:credentials|auth)\.json$/.test(entry.name)
            ) {
                skipped.push({
                    path: name,
                    reason: 'dependency-cache-or-credential-file',
                });
                continue;
            }
            if (entry.isDirectory()) {
                visit(path, name + '/');
                continue;
            }
            if (!entry.isFile()) {
                skipped.push({ path: name, reason: 'not-regular-file' });
                continue;
            }
            const size = lstatSync(path).size;
            if (files.length >= 2000 || bytes + size > 256 * 1024 * 1024) {
                skipped.push({ path: name, reason: 'retention-limit' });
                continue;
            }
            let data = readFileSync(path);
            let redacted = false;
            if (data.includes(0)) {
                if (credentials.some((secret) => data.includes(Buffer.from(secret)))) {
                    skipped.push({ path: name, reason: 'credential-bearing-binary' });
                    continue;
                }
            } else {
                const original = data.toString('utf8');
                let text = original;
                for (const secret of credentials)
                    text = text.replaceAll(secret, '[REDACTED]');
                text = text
                    .replace(/\bsk-[A-Za-z0-9_-]+/g, '[REDACTED]')
                    .replace(/\bBearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [REDACTED]')
                    .replace(/\bBasic\s+[A-Za-z0-9+/_=-]+/gi, 'Basic [REDACTED]');
                redacted = text !== original;
                data = Buffer.from(text);
            }
            const target = join(destination, name);
            mkdirSync(join(target, '..'), { recursive: true, mode: 0o700 });
            writeFileSync(target, data, { mode: 0o600 });
            files.push({
                path: name,
                bytes: data.length,
                sha256: createHash('sha256').update(data).digest('hex'),
                redacted,
            });
            bytes += size;
        }
    };
    visit(source);
    const manifest = { version: 1, files, skipped };
    writeFileSync(
        join(evidence, 'artifacts.json'),
        JSON.stringify(manifest, null, 2) + '\n',
        { mode: 0o600 }
    );
    return manifest;
}
