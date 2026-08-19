import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveWorkbench } from './manifest.js';
import { buildOpenCodeInvocation, publicInvocation } from './opencode.js';
import { preflightWorkbench } from './preflight.js';
import type { ResolvedWorkbench } from './types.js';

export interface RunOptions {
    workbenchPath: string;
    task: string;
    dryRun?: boolean;
    workspaceDirectory?: string;
}

export interface RunDependencies {
    env?: Record<string, string | undefined>;
    findExecutable?: (name: string) => string | null;
    spawn?: (
        command: string[],
        options: {
            cwd: string;
            env: Record<string, string | undefined>;
            stdin: 'inherit';
            stdout: 'inherit';
            stderr: 'inherit';
        }
    ) => { exited: Promise<number> };
    write?: (value: string) => void;
}

export async function runWorkbench(
    options: RunOptions,
    dependencies: RunDependencies = {}
): Promise<number> {
    const workbench = await resolveWorkbench(options.workbenchPath);
    const environment = dependencies.env ?? process.env;
    const findExecutable = dependencies.findExecutable ?? Bun.which;
    const spawn = dependencies.spawn ?? defaultSpawn;
    const write =
        dependencies.write ?? ((value: string) => process.stdout.write(value));

    preflightWorkbench(workbench, { env: environment, findExecutable });

    const staged = await stageOpenCodeSkills(workbench);
    try {
        const invocation = buildOpenCodeInvocation(
            workbench,
            options.task,
            environment,
            staged?.directory,
            options.workspaceDirectory
        );
        if (options.dryRun) {
            write(
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
        const child = spawn([command, ...args], {
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

function defaultSpawn(
    command: string[],
    options: {
        cwd: string;
        env: Record<string, string | undefined>;
        stdin: 'inherit';
        stdout: 'inherit';
        stderr: 'inherit';
    }
) {
    return Bun.spawn(command, options);
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
                symlink(skill.directory, join(skillsDirectory, skill.name), 'dir')
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
