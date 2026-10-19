import { stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

import type { CloudRuns } from '../cloud/index.js';
import type { DetachedRunLauncher } from '../runs/detached.js';

export interface McpRunRequest {
    workbench: string | { version_id: string };
    task: string;
    project?: string;
    dir?: string;
    runtime?: string;
    where?: 'local' | 'cloud';
    org?: string;
    session_id?: string;
    repository?: string;
    ref?: string;
    idempotency_key?: string;
}

export interface McpLocalRunReceipt {
    session_id: string;
    run_id: string;
    wait_command: string;
    send_command: string;
}

export interface McpCloudRunReceipt {
    session_id: string;
    run_id: string;
    tools: Record<'wait' | 'send' | 'answer' | 'cancel', { session_id: string }>;
}

export type McpRunReceipt = McpLocalRunReceipt | McpCloudRunReceipt;

/** Starts MCP `run` requests locally as detached runs or through the cloud API. */
export class McpRunLauncher {
    constructor(
        private readonly cwd: string,
        private readonly launcher: Pick<DetachedRunLauncher, 'start'>,
        private readonly cloud: Pick<CloudRuns, 'start'>
    ) {}

    async start(request: McpRunRequest): Promise<McpRunReceipt> {
        if (request.where === 'cloud') return this.startCloud(request);
        if (typeof request.workbench !== 'string')
            throw new Error('Local runs require workbench to be a saved alias');
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

    private async startCloud(request: McpRunRequest): Promise<McpCloudRunReceipt> {
        if (!request.project) throw new Error('Cloud runs require project');
        if (request.dir || request.runtime)
            throw new Error('Cloud runs do not accept dir or runtime');
        const run = await this.cloud.start({
            workbench: request.workbench,
            task: request.task,
            project: request.project,
            ...(request.org !== undefined ? { org: request.org } : {}),
            ...(request.session_id !== undefined
                ? { session_id: request.session_id }
                : {}),
            ...(request.repository !== undefined
                ? { repository: request.repository }
                : {}),
            ...(request.ref !== undefined ? { ref: request.ref } : {}),
            ...(request.idempotency_key !== undefined
                ? { idempotency_key: request.idempotency_key }
                : {}),
        });
        return {
            ...run,
            tools: {
                wait: { session_id: run.session_id },
                send: { session_id: run.session_id },
                answer: { session_id: run.session_id },
                cancel: { session_id: run.session_id },
            },
        };
    }
}
