import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RunnerContext } from '../../../src/runners/context/files.js';
import { RunnerContextStaging } from '../../../src/runners/context/stage.js';
import { DiskRunnerFiles } from '../../../src/runners/files/disk.js';
import { MemoryRunnerFiles } from '../../../src/runners/files/memory.js';
import { OpenCodeRunner } from '../../../src/runners/opencode/runner.js';
import {
    OpenCodeSkillStaging,
    StagedOpenCodeSkills,
} from '../../../src/runners/opencode/skills.js';
import type { RunnerFiles } from '../../../src/runners/types.js';
import type { ResolvedWorkbench } from '../../../src/types.js';
import { modelCatalogFixture } from '../../model-catalog-fixture.js';

const directories: string[] = [];

afterAll(async () => {
    await Promise.all(
        directories.map((path) => rm(path, { recursive: true, force: true }))
    );
});

const backends: Array<[string, () => Promise<{ files: RunnerFiles; root: string }>]> = [
    ['memory', async () => ({ files: new MemoryRunnerFiles(), root: '/root' })],
    [
        'disk',
        async () => {
            const root = await mkdtemp(join(tmpdir(), 'workbench-runner-files-'));
            directories.push(root);
            return { files: new DiskRunnerFiles(), root };
        },
    ],
];

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

test('memory realpath resolves links in parent directories', async () => {
    const files = new MemoryRunnerFiles()
        .directory('/workspace/real')
        .file('/workspace/real/CLAUDE.md', '# Instructions');
    await files.symlink('real', '/workspace/link');

    expect(await files.realpath('/workspace/link/CLAUDE.md')).toBe(
        '/workspace/real/CLAUDE.md'
    );
});

for (const [name, create] of backends) {
    describe(`RunnerFiles on ${name}`, () => {
        test('writes, reads, and refuses to replace an exclusive file', async () => {
            const { files, root } = await create();
            await files.mkdir(root, { recursive: true });
            await files.writeFile(join(root, 'a.txt'), 'alpha', { mode: 0o600 });
            expect(text(await files.readFile(join(root, 'a.txt')))).toBe('alpha');
            await expect(
                files.writeFile(join(root, 'a.txt'), 'again', { exclusive: true })
            ).rejects.toThrow();
            await files.writeFile(join(root, 'a.txt'), 'replaced');
            expect(text(await files.readFile(join(root, 'a.txt')))).toBe('replaced');
        });

        test('creates directories strictly unless asked to recurse', async () => {
            const { files, root } = await create();
            await files.mkdir(root, { recursive: true });
            await files.mkdir(join(root, 'one'));
            await expect(files.mkdir(join(root, 'one'))).rejects.toThrow();
            await files.mkdir(join(root, 'one'), { recursive: true });
            await files.mkdir(join(root, 'a', 'b', 'c'), { recursive: true });
            await expect(
                files.writeFile(join(root, 'missing', 'x.txt'), 'x')
            ).rejects.toThrow();
        });

        test('lists names and describes paths without following links', async () => {
            const { files, root } = await create();
            await files.mkdir(join(root, 'dir'), { recursive: true });
            await files.writeFile(join(root, 'dir', 'f.txt'), 'four');
            await files.writeFile(join(root, 'top.txt'), 'x');
            expect((await files.list(root)).toSorted()).toEqual(['dir', 'top.txt']);
            expect(await files.lstat(join(root, 'dir', 'f.txt'))).toMatchObject({
                kind: 'file',
                size: 4,
            });
            expect((await files.lstat(join(root, 'dir')))?.kind).toBe('directory');
            expect(await files.lstat(join(root, 'none'))).toBeUndefined();
        });

        test('links paths and follows the link only when asked', async () => {
            const { files, root } = await create();
            await files.mkdir(root, { recursive: true });
            await files.writeFile(join(root, 'target.txt'), 'four');
            await files.symlink(join(root, 'target.txt'), join(root, 'link'));
            await expect(
                files.symlink(join(root, 'target.txt'), join(root, 'link'))
            ).rejects.toThrow();
            expect((await files.lstat(join(root, 'link')))?.kind).toBe('symlink');
            expect(await files.stat(join(root, 'link'))).toMatchObject({
                kind: 'file',
                size: 4,
            });
            await files.symlink(join(root, 'gone'), join(root, 'dangling'));
            expect(await files.stat(join(root, 'dangling'))).toBeUndefined();
        });

        test('copies a tree, changes modes, and removes recursively', async () => {
            const { files, root } = await create();
            await files.mkdir(join(root, 'src', 'inner'), { recursive: true });
            await files.writeFile(join(root, 'src', 'inner', 'f.txt'), 'deep');
            await files.writeFile(join(root, 'src', 'g.txt'), 'top');
            await files.copy(join(root, 'src'), join(root, 'copy'));
            expect(
                text(await files.readFile(join(root, 'copy', 'inner', 'f.txt')))
            ).toBe('deep');
            await files.chmod(join(root, 'copy'), 0o555);
            await files.chmod(join(root, 'copy'), 0o755);
            await files.remove(join(root, 'copy'));
            expect(await files.lstat(join(root, 'copy'))).toBeUndefined();
            await files.remove(join(root, 'never-existed'));
            expect(await files.lstat(join(root, 'src', 'g.txt'))).toBeDefined();
        });

        test('hands out distinct private temporary directories', async () => {
            const { files } = await create();
            const first = await files.tempDirectory('workbench-test-');
            const second = await files.tempDirectory('workbench-test-');
            expect(first).not.toBe(second);
            expect((await files.lstat(first))?.kind).toBe('directory');
            await files.remove(first);
            await files.remove(second);
        });
    });
}

describe('an OpenCode runner over in-memory files', () => {
    test('stages skills and instructions through the injected storage', async () => {
        const files = new MemoryRunnerFiles()
            .file('/pkg/instructions.md', 'Be precise.')
            .file('/pkg/skills/review/SKILL.md', 'Review carefully.');
        const workbench = {
            manifestPath: '/pkg/workbench.yml',
            packageDirectory: '/pkg',
            repositoryDirectory: '/ws',
            instructionsPath: '/pkg/instructions.md',
            skills: [
                {
                    name: 'review',
                    directory: '/pkg/skills/review',
                    manifestPath: '/pkg/skills/review/SKILL.md',
                },
            ],
            manifest: {
                spec: 1,
                version: '0.1.0',
                name: 'memory-runner',
                runner: 'opencode',
                model: { id: 'openai/gpt-5.6-terra' },
                instructions: './instructions.md',
                skills: ['./skills/review'],
                tools: [],
                mcps: [],
                env: {},
            },
        } as unknown as ResolvedWorkbench;
        const runner = new OpenCodeRunner({
            skills: new OpenCodeSkillStaging(files, new RunnerContextStaging(files)),
            catalog: modelCatalogFixture,
        });
        const prepared = await runner.prepare(workbench);
        try {
            const [staged] = prepared.assets;
            expect(staged?.access).toBe('read-write');
            expect(files.text(`${staged?.path}/skills/review/SKILL.md`)).toBe(
                'Review carefully.'
            );
            expect(
                files.text(`${staged?.path}/.workbench-context/system.md`)
            ).toContain('Be precise.');
            // Staged skills are read-only until cleanup.
            expect(files.mode(staged?.path ?? '')).toBe(0o555);
        } finally {
            await prepared.cleanup();
        }
        expect(files.paths().some((path) => path.includes('workbench-opencode-'))).toBe(
            false
        );
    });

    test('lets a host replace how skills are staged', async () => {
        const files = new MemoryRunnerFiles().file('/pkg/instructions.md', 'x');
        let called = 0;
        class StubSkills extends OpenCodeSkillStaging {
            override async stage() {
                called++;
                return new StagedOpenCodeSkills(
                    files,
                    '/staged',
                    new RunnerContext('/staged/prefix.md', '/staged/system.md')
                );
            }
        }
        const runner = new OpenCodeRunner({
            skills: new StubSkills(files, new RunnerContextStaging(files)),
            catalog: modelCatalogFixture,
        });
        const prepared = await runner.prepare({
            manifest: { runner: 'opencode' },
        } as unknown as ResolvedWorkbench);
        expect(called).toBe(1);
        expect(prepared.assets[0]?.path).toBe('/staged');
    });
});
