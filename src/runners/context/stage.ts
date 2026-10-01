import { join } from 'node:path';

import type { ResolvedWorkbench } from '../../types.js';
import type { RunnerFiles } from '../types.js';
import { RunnerContext } from './files.js';
import { escapeXml, runnerContextProtocol } from './runtime.js';

export interface RunnerContextRequest {
    directory: string;
    workbench: ResolvedWorkbench;
    nativeInstructions?: string;
    /** Where the combined instructions are written. Defaults beside the prefix. */
    instructions?: string;
}

/** Writes the runner's context files through `files`. */
export class RunnerContextStaging {
    constructor(private readonly files: RunnerFiles) {}

    async stage(request: RunnerContextRequest): Promise<RunnerContext> {
        const { directory, workbench, nativeInstructions = '' } = request;
        const instructions =
            request.instructions ?? join(directory, '.workbench-context', 'system.md');
        const contextDirectory = join(directory, '.workbench-context');
        // A package cannot supply files in the engine's private staging namespace.
        await this.files.mkdir(contextDirectory);
        const packageInstructions = new TextDecoder().decode(
            await this.files.readFile(workbench.instructionsPath)
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
        await this.files.writeFile(prefix, `${content}\n`, {
            mode: 0o444,
            exclusive: true,
        });
        const existing = await this.files.lstat(instructions);
        if (existing && existing.kind !== 'file') {
            throw new Error('Staged Workbench instructions must be a regular file');
        }
        await this.files.writeFile(instructions, `${content}\n`, { mode: 0o644 });
        return new RunnerContext(prefix, instructions);
    }
}
