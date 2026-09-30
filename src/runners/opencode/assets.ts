import type { ResolvedWorkbench } from '../../types.js';
import type { RunnerFiles } from '../files.js';
import { diskRunnerFiles } from '../files-disk.js';
import { type StagedOpenCodeSkills, stageOpenCodeSkillsWith } from './staging.js';

/** Stages OpenCode skills on the local disk unless a host supplies its own files. */
export function stageOpenCodeSkills(
    workbench: ResolvedWorkbench,
    files: RunnerFiles = diskRunnerFiles
): Promise<StagedOpenCodeSkills> {
    return stageOpenCodeSkillsWith(files, workbench);
}
