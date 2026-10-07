import { describe, expect, test } from 'bun:test';

import { RunnerContextStaging } from '../../../src/runners/context/stage.js';
import { MemoryRunnerFiles } from '../../../src/runners/files/memory.js';
import { OpenCodeSkillStaging } from '../../../src/runners/opencode/skills.js';
import type { ResolvedWorkbench } from '../../../src/types.js';

function workbench(runnerConfigPath?: string): ResolvedWorkbench {
    return {
        manifestPath: '/pkg/workbench.yml',
        packageDirectory: '/pkg',
        repositoryDirectory: '/pkg',
        instructionsPath: '/pkg/instructions.md',
        ...(runnerConfigPath ? { runnerConfigPath } : {}),
        skills: [
            {
                name: 'review',
                directory: '/pkg/skills/review',
                manifestPath: '/pkg/skills/review/SKILL.md',
            },
        ],
        manifest: {
            spec: 0,
            version: '0.1.0',
            name: 'probe',
            runner: 'opencode',
            model: { id: 'openai/gpt-5.6-terra' },
            instructions: './instructions.md',
            skills: ['./skills/review'],
            tools: [],
            mcps: [],
            env: {},
            runtime: 'local',
        },
    } as unknown as ResolvedWorkbench;
}

function staging(files: MemoryRunnerFiles) {
    return new OpenCodeSkillStaging(files, new RunnerContextStaging(files));
}

describe('OpenCode skill staging', () => {
    test('stages skills and context without a local filesystem', async () => {
        const files = new MemoryRunnerFiles()
            .file('/pkg/instructions.md', '# Authored behavior')
            .file('/pkg/skills/review/SKILL.md', 'Review carefully.');

        const staged = await staging(files).stage(workbench());

        expect(staged.directory).toStartWith('/tmp/workbench-opencode-');
        expect(files.text(`${staged.directory}/skills/review/SKILL.md`)).toBe(
            'Review carefully.'
        );
        expect(files.text(staged.context.prefix)).toContain('# Authored behavior');
        expect(files.mode(staged.context.prefix)).toBe(0o444);
        expect(files.mode(staged.directory)).toBe(0o555);

        await staged.cleanup();
        expect(await files.lstat(staged.directory)).toBeUndefined();
    });

    test('copies a packaged config directory beside the skills', async () => {
        const files = new MemoryRunnerFiles()
            .file('/pkg/instructions.md', '# Authored behavior')
            .file('/pkg/skills/review/SKILL.md', 'Review carefully.')
            .file('/pkg/config/opencode.json', '{}');

        const staged = await staging(files).stage(workbench('/pkg/config'));

        expect(files.text(`${staged.directory}/opencode.json`)).toBe('{}');
        expect(staged.nativeConfigFile).toBeUndefined();
    });

    test('points a file config at a private copy of the package', async () => {
        const files = new MemoryRunnerFiles()
            .file('/pkg/instructions.md', '# Authored behavior')
            .file('/pkg/skills/review/SKILL.md', 'Review carefully.')
            .file('/pkg/opencode.json', '{}');

        const staged = await staging(files).stage(workbench('/pkg/opencode.json'));

        expect(staged.nativeConfigFile).toBe(
            `${staged.directory}/native/opencode.json`
        );
        expect(files.text(staged.nativeConfigFile as string)).toBe('{}');
    });

    test('removes the directory when staging fails', async () => {
        const files = new MemoryRunnerFiles().file('/pkg/skills/review/SKILL.md', 'x');

        await expect(staging(files).stage(workbench())).rejects.toThrow();

        expect(
            files.paths().filter((path) => path.includes('workbench-opencode-'))
        ).toEqual([]);
    });

    test('refuses skill symlinks outside the package without chmodding the target', async () => {
        const files = new MemoryRunnerFiles()
            .file('/pkg/instructions.md', '# Authored behavior')
            .file('/pkg/skills/review/SKILL.md', 'Review carefully.')
            .file('/outside.sh', '#!/bin/sh\n', 0o755);
        await files.symlink('/outside.sh', '/pkg/skills/review/outside.sh');

        await expect(staging(files).stage(workbench())).rejects.toThrow(
            'outside.sh was skipped'
        );
        expect(files.mode('/outside.sh')).toBe(0o755);
    });

    test('refuses a runner config that does not exist', async () => {
        const files = new MemoryRunnerFiles();

        await expect(staging(files).stage(workbench('/pkg/missing'))).rejects.toThrow(
            'Runner configuration does not exist: /pkg/missing'
        );
    });
});
