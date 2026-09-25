import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { retainCampaignSource } from './campaign-source.ts';
import type { Paths } from './runtime.ts';
import type { TaskSpec } from './spec.ts';
import { fingerprint } from './trial.ts';

const temporary: string[] = [];
afterEach(() => {
    for (const path of temporary.splice(0))
        rmSync(path, { recursive: true, force: true });
});
function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'wbm-campaign-source-'));
    temporary.push(root);
    const paths: Paths = {
        bench: join(root, 'custom harness'),
        tasks: join(root, 'custom tasks'),
        workbenches: join(root, 'custom packages'),
        results: join(root, 'results'),
        work: join(root, 'work'),
        imageCache: join(root, 'images'),
    };
    const task: TaskSpec = {
        version: 1,
        id: 'example',
        workbench: 'expert',
        title: 'Example',
        fixture: { kind: 'empty' },
        criteria: [{ id: 'renders', text: 'It renders' }],
    };
    const files = new Map([
        [join(paths.bench, 'workbenchmark.ts'), 'export const cli = true;'],
        [join(paths.bench, 'package.json'), '{"type":"module"}'],
        [join(paths.bench, 'lib', 'runtime.ts'), 'export const runtime = true;'],
        [join(paths.tasks, 'example', 'task.json'), JSON.stringify(task)],
        [join(paths.tasks, 'example', 'prompt.md'), 'Make a useful page.'],
        [join(paths.tasks, 'example', 'checks', 'check.sh'), '#!/bin/sh\nexit 0\n'],
        [join(paths.workbenches, 'expert', 'workbench.yml'), 'spec: 0\nname: expert\n'],
        [
            join(paths.workbenches, 'grader', 'instructions.md'),
            'Judge observed behavior.',
        ],
    ]);
    for (const [path, text] of files) {
        mkdirSync(join(path, '..'), { recursive: true });
        writeFileSync(path, text);
    }
    chmodSync(join(paths.tasks, 'example', 'checks', 'check.sh'), 0o755);
    const directory = join(paths.results, 'campaign');
    mkdirSync(directory, { recursive: true });
    return { root, paths, task, directory };
}

test('snapshot restores custom task/package roots, executable modes, and the exact harness', () => {
    const { root, paths, task, directory } = fixture();
    const excluded = join(paths.bench, 'lib', '.git');
    mkdirSync(excluded);
    writeFileSync(join(excluded, 'config'), 'not protocol source');
    retainCampaignSource(paths, [task], directory);
    const metadata = JSON.parse(
        readFileSync(join(directory, 'protocol-source.json'), 'utf8')
    );
    const archive = join(directory, metadata.archive);
    expect(createHash('sha256').update(readFileSync(archive)).digest('hex')).toBe(
        metadata.sha256
    );
    const restored = join(root, 'restored');
    mkdirSync(restored);
    expect(Bun.spawnSync(['tar', '-xzf', archive, '-C', restored]).exitCode).toBe(0);
    for (const [name, hash] of Object.entries(metadata.fingerprints))
        expect(fingerprint(join(restored, name))).toBe(hash as string);
    expect(readFileSync(join(restored, 'tasks/example/prompt.md'), 'utf8')).toBe(
        'Make a useful page.'
    );
    expect(
        readFileSync(join(restored, '.workbenches/expert/workbench.yml'), 'utf8')
    ).toContain('name: expert');
    expect(existsSync(join(restored, 'lib/.git'))).toBe(false);
    expect(
        readdirSync(directory).some((name) => name.startsWith('.source-build-'))
    ).toBe(false);
});

test('credential environment files fail capture without retaining secret scratch or archives', () => {
    const { paths, task, directory } = fixture();
    writeFileSync(join(paths.workbenches, 'expert', '.env'), 'API_KEY=private');
    expect(() => retainCampaignSource(paths, [task], directory)).toThrow(
        'credential environment files'
    );
    expect(readdirSync(directory)).toEqual([]);
});

test('protocol source cannot follow symlinks into unrelated files', () => {
    const { root, paths, task, directory } = fixture();
    const external = join(root, 'external');
    writeFileSync(external, 'private');
    symlinkSync(external, join(paths.bench, 'lib', 'link'));
    expect(() => retainCampaignSource(paths, [task], directory)).toThrow('symlink');
    expect(readFileSync(external, 'utf8')).toBe('private');
    expect(readdirSync(directory)).toEqual([]);
});

test('a campaign source snapshot is never silently replaced', () => {
    const { paths, task, directory } = fixture();
    retainCampaignSource(paths, [task], directory);
    const before = readFileSync(join(directory, 'protocol-source.json'), 'utf8');
    expect(() => retainCampaignSource(paths, [task], directory)).toThrow(
        'already exists'
    );
    expect(readFileSync(join(directory, 'protocol-source.json'), 'utf8')).toBe(before);
});
