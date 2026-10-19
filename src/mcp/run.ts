import { stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

import type { DetachedRunLauncher } from '../runs/detached.js';

export interface McpRunRequest {
    workbench: string;
    task: string;
    project?: string;
    dir?: string;
    runtime?: string;
}

export interface McpRunReceipt {
    session_id: string;
    run_id: string;
    wait_command: string;
    send_command: string;
}

/** Starts MCP `run` requests as detached local runs. */
export class McpRunLauncher {
    constructor(
        private readonly cwd: string,
        private readonly launcher: Pick<DetachedRunLauncher, 'start'>
    ) {}

    async start(request: McpRunRequest): Promise<McpRunReceipt> {
        const directory = request.dir ?? this.cwd;
        if (!isAbsolute(directory))
            throw new Error('Run directory must be an absolute path');
        const info = await stat(directory).catch(() => undefined);
        if (!info?.isDirectory())
            throw new Error(`Run directory does not exist: ${directory}`);
        if (!request.task.trim()) throw new Error('Run task cannot be empty');

        const run = await this.launcher.start({
            workbench: request.workbench,
            task: request.task,
            directory: resolve(directory),
            rawArgs: [],
            environmentOverrides: { file: {}, explicit: new Map() },
            allowHostDocker: false,
            allowUncheckedGpu: false,
            ...(request.runtime ? { runtime: request.runtime } : {}),
            ...(request.project ? { project: request.project } : {}),
        });
        const sessionId = run.session_id ?? run.id;
        return {
            session_id: sessionId,
            run_id: run.id,
            wait_command: `wb wait ${run.id}`,
            send_command: `wb send ${sessionId} <message>`,
        };
    }
}
