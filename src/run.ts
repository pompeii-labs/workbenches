import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveWorkbench } from './manifest.js';
import { buildOpenCodeInvocation, publicInvocation } from './opencode.js';
import type { ResolvedWorkbench } from './types.js';

export interface RunOptions {
    workbenchPath: string;
    task: string;
    dryRun?: boolean;
}

export async function runWorkbench(options: RunOptions): Promise<number> {
    const workbench = await resolveWorkbench(options.workbenchPath);

    for (const tool of workbench.manifest.tools) {
        if (!Bun.which(tool)) throw new Error(`Required CLI tool is unavailable: ${tool}`);
    }

    const staged = await stageOpenCodeSkills(workbench);
    try {
        const invocation = buildOpenCodeInvocation(
            workbench,
            options.task,
            process.env,
            staged?.directory
        );
        if (options.dryRun) {
            process.stdout.write(
                `${JSON.stringify(
                    {
                        ...publicInvocation(invocation),
                        skills: workbench.skills.map((skill) => skill.name),
                    },
                    null,
                    2
                )}\n`
            );
            return 0;
        }

        const [command, ...args] = invocation.command;
        if (!command) throw new Error('Runner command is empty');
        const child = Bun.spawn([command, ...args], {
            cwd: invocation.cwd,
            env: invocation.env,
            stdin: 'inherit',
            stdout: 'inherit',
            stderr: 'inherit',
        });
        return await child.exited;
    } finally {
        await staged?.cleanup();
    }
}

export async function stageOpenCodeSkills(
    workbench: ResolvedWorkbench
): Promise<{ directory: string; cleanup: () => Promise<void> } | undefined> {
    if (workbench.skills.length === 0) return undefined;
    const directory = await mkdtemp(join(tmpdir(), 'workbench-opencode-'));
    const skillsDirectory = join(directory, 'skills');
    await mkdir(skillsDirectory);
    try {
        await Promise.all(
            workbench.skills.map((skill) =>
                symlink(
                    skill.directory,
                    join(skillsDirectory, skill.name),
                    'dir'
                )
            )
        );
    } catch (error) {
        await rm(directory, { recursive: true, force: true });
        throw error;
    }
    return {
        directory,
        cleanup: () => rm(directory, { recursive: true, force: true }),
    };
}
