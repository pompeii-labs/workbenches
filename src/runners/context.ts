import type { ResolvedWorkbench } from '../types.js';
import { stageRunnerContextWith } from './context-staging.js';
import type { RunnerFiles } from './files.js';
import { diskRunnerFiles } from './files-disk.js';
import type { RunnerContextFiles } from './runtime-context.js';

export {
    type RunnerContextFiles,
    remapRunnerContext,
    runtimeContext,
    withRunnerContext,
} from './runtime-context.js';

/**
 * Stages the runner context on the local disk, or through `files` when a host
 * supplies its own storage. The pure context builders live in `runtime-context.ts`.
 */
export function stageRunnerContext(
    directory: string,
    workbench: ResolvedWorkbench,
    nativeInstructions = '',
    instructions?: string,
    files: RunnerFiles = diskRunnerFiles
): Promise<RunnerContextFiles> {
    return stageRunnerContextWith(
        files,
        directory,
        workbench,
        nativeInstructions,
        instructions
    );
}
