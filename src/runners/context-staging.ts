import { join } from 'node:path';

import type { ResolvedWorkbench } from '../types.js';
import type { RunnerFiles } from './files.js';
import {
    escapeXml,
    type RunnerContextFiles,
    runnerContextProtocol,
} from './runtime-context.js';

/** Writes the runner's context files through `files`. */
export async function stageRunnerContextWith(
    files: RunnerFiles,
    directory: string,
    workbench: ResolvedWorkbench,
    nativeInstructions = '',
    instructions = join(directory, '.workbench-context', 'system.md')
): Promise<RunnerContextFiles> {
    const contextDirectory = join(directory, '.workbench-context');
    // A package cannot supply files in the engine's private staging namespace.
    await files.mkdir(contextDirectory);
    const packageInstructions = new TextDecoder().decode(
        await files.readFile(workbench.instructionsPath)
    );
    const prefix = join(contextDirectory, 'prefix.md');
    const content = [
        runnerContextProtocol,
        `<workbench_package name="${escapeXml(workbench.manifest.name)}" version="${escapeXml(workbench.manifest.version)}" />`,
        nativeInstructions.trim(),
        packageInstructions.trim(),
    ]
        .filter(Boolean)
        .join('\n\n');
    await files.writeFile(prefix, `${content}\n`, { mode: 0o444, exclusive: true });
    const existing = await files.stat(instructions);
    if (existing && existing.kind !== 'file') {
        throw new Error('Staged Workbench instructions must be a regular file');
    }
    await files.writeFile(instructions, `${content}\n`, { mode: 0o644 });
    return { prefix, instructions };
}
