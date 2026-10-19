import type { CloudRuns } from '../cloud/index.js';
import type { ProjectStore } from '../projects/store.js';
import type { RunStore } from '../runs/store.js';
import type { PendingRunRequest, RunSupervision } from '../runs/supervision.js';
import type { SessionControl } from '../sessions/control.js';
import type { SessionLifecycle } from '../sessions/lifecycle.js';
import type { SessionSupervision } from '../sessions/supervision.js';
import type { McpCloudWait } from './waits.js';

export interface McpWaitRequest {
    sessionId?: string;
    runId?: string;
    after?: number;
    timeoutSeconds?: number;
}

/** Wait, input, cancellation, and history across local and tracked cloud sessions. */
export class McpSupervision {
    constructor(
        private readonly cloud: CloudRuns,
        private readonly cloudWait: Pick<McpCloudWait, 'wait'>,
        private readonly sessionSupervision: Pick<
            SessionSupervision,
            'resolve' | 'wait'
        >,
        private readonly control: Pick<SessionControl, 'send' | 'answer' | 'cancel'>,
        private readonly lifecycle: Pick<SessionLifecycle, 'list'>,
        private readonly runStore: Pick<RunStore, 'list' | 'reconcile'>,
        private readonly supervision: Pick<RunSupervision, 'snapshot'>,
        private readonly projects: Pick<ProjectStore, 'resolve'>
    ) {}

    async wait(request: McpWaitRequest): Promise<Record<string, unknown>> {
        const exactRun = request.runId !== undefined;
        const id = request.runId ?? request.sessionId;
        if (!id) throw new Error('wait requires session_id or run_id');
        const cloud = this.cloud;
        const tracked = request.runId
            ? cloud.trackedRun(request.runId)
            : cloud.trackedSession(id);
        if (tracked)
            return this.cloudWait.wait(
                cloud,
                tracked.sessionId,
                tracked.latestRunId,
                request
            );
        const supervision = this.sessionSupervision;
        const run = await supervision.resolve(id, { exactRun });
        const result = await supervision.wait(run, {
            ...(request.after !== undefined ? { afterSequence: request.after } : {}),
            timeoutMilliseconds: Math.min(request.timeoutSeconds ?? 60, 60) * 1000,
        });
        return {
            session_id: result.session_id,
            run_id: result.run_id,
            next: result.sequence,
            state: result.state,
            final: result.final,
            usage: result.usage,
            usage_total: result.usage_total,
            pending_requests: result.pending_requests.map(pendingRequest),
            ...(result.outcome_id ? { outcome_id: result.outcome_id } : {}),
            ...(result.error ? { error: result.error } : {}),
        };
    }

    async send(
        sessionId: string,
        text: string,
        mode: 'send' | 'steer' | 'queue'
    ): Promise<Record<string, unknown>> {
        const cloud = this.cloud;
        const tracked = cloud.trackedSession(sessionId);
        if (tracked)
            return cloudReceipt(
                sessionId,
                tracked.latestRunId,
                await cloud.command(sessionId, mode, { text })
            );
        return { ...(await this.control.send(sessionId, text, mode)) };
    }

    async answer(
        sessionId: string,
        requestId: string,
        response: string | string[][]
    ): Promise<Record<string, unknown>> {
        const cloud = this.cloud;
        const tracked = cloud.trackedSession(sessionId);
        if (tracked)
            return cloudReceipt(
                sessionId,
                tracked.latestRunId,
                await cloud.command(sessionId, 'answer', {
                    request_id: requestId,
                    response,
                })
            );
        return {
            ...(await this.control.answer(
                sessionId,
                requestId,
                typeof response === 'string' ? response : JSON.stringify(response)
            )),
        };
    }

    async cancel(sessionId: string): Promise<Record<string, unknown>> {
        const cloud = this.cloud;
        const tracked = cloud.trackedSession(sessionId);
        if (tracked) {
            await cloud.command(sessionId, 'cancel', {});
            return {
                session_id: sessionId,
                run_id: tracked.latestRunId,
                state: 'cancelled',
            };
        }
        return {
            ...(await this.control.cancel(sessionId)),
            state: 'cancelled',
        };
    }

    async runs(options: {
        project?: string;
        status?: string;
        limit: number;
    }): Promise<Record<string, unknown>[]> {
        const project = await this.project(options.project);
        const sessions = await this.lifecycle.list({ all: true });
        const projects = new Map(
            sessions.map((activity) => [activity.id, activity.session?.project ?? null])
        );
        const store = this.runStore;
        const runs = await Promise.all(
            (await store.list()).map((run) => store.reconcile(run))
        );
        const local = runs
            .filter((run) => !options.status || run.status === options.status)
            .map((run) => ({
                id: run.id,
                session_id: run.session_id ?? run.id,
                project: projects.get(run.session_id ?? run.id) ?? null,
                status: run.status,
                workbench: run.workbench,
                workbench_version: run.workbench_version,
                runner: run.runner,
                model: run.model,
                runtime: run.runtime ?? 'local',
                dispatched_at: run.dispatched_at,
                ...(run.finished_at ? { finished_at: run.finished_at } : {}),
                ...(run.task ? { task: run.task } : {}),
            }))
            .filter((run) => !project || run.project === project);
        const cloud = await this.cloudRuns(project, options.status);
        return [...local, ...cloud]
            .toSorted((left, right) =>
                String(right.dispatched_at).localeCompare(String(left.dispatched_at))
            )
            .slice(0, options.limit);
    }

    async sessions(options: {
        project?: string;
        limit: number;
    }): Promise<Record<string, unknown>[]> {
        const project = await this.project(options.project);
        const activities = (await this.lifecycle.list({ all: true }))
            .filter((activity) => !project || activity.session?.project === project)
            .slice(0, options.limit);
        const local = await Promise.all(
            activities.map(async (activity) => {
                const snapshot = await this.supervision.snapshot(activity.run);
                return {
                    session_id: activity.id,
                    project: activity.session?.project ?? null,
                    state: snapshot.state,
                    needs_input: snapshot.state === 'needs_input',
                    pending_requests: snapshot.pending_requests.map(pendingRequest),
                    latest_run: {
                        id: activity.run.id,
                        status: activity.run.status,
                        workbench: activity.run.workbench,
                        dispatched_at: activity.run.dispatched_at,
                    },
                };
            })
        );
        const cloud = this.cloud;
        if (!(await cloud.login())) return local;
        const remote = await Promise.all(
            (await accessibleTracked(cloud, project)).map(async (tracked) => {
                const run = await cloud.run(tracked.latestRunId);
                return {
                    session_id: tracked.sessionId,
                    project: tracked.project,
                    state:
                        run.status === 'needs_input' ||
                        run.status === 'completed' ||
                        run.status === 'failed' ||
                        run.status === 'cancelled'
                            ? run.status
                            : 'running',
                    needs_input: run.status === 'needs_input',
                    pending_requests: [],
                    latest_run: {
                        id: run.id,
                        status: run.status,
                        workbench: tracked.workbench,
                        dispatched_at: run.created_at,
                    },
                };
            })
        );
        return [...local, ...remote]
            .toSorted((left, right) =>
                right.latest_run.dispatched_at.localeCompare(
                    left.latest_run.dispatched_at
                )
            )
            .slice(0, options.limit);
    }

    private async cloudRuns(
        project: string | undefined,
        status: string | undefined
    ): Promise<Record<string, unknown>[]> {
        const cloud = this.cloud;
        if (!(await cloud.login())) return [];
        const pages = await Promise.all(
            (await accessibleTracked(cloud, project)).map(async (tracked) => ({
                tracked,
                runs: await cloud.runs(tracked),
            }))
        );
        return pages.flatMap(({ tracked, runs }) =>
            runs
                .filter((run) => !status || run.status === status)
                .map((run) => ({
                    id: run.id,
                    session_id: run.session_id,
                    project: tracked.project,
                    status: run.status,
                    workbench: `${run.workbench.organization_slug}/${run.workbench.slug}`,
                    workbench_version: run.version.version,
                    runner: 'cloud',
                    model: 'cloud',
                    runtime: 'cloud',
                    dispatched_at: run.created_at,
                    ...(run.completed_at ? { finished_at: run.completed_at } : {}),
                    task: run.task,
                }))
        );
    }

    private async project(value?: string): Promise<string | undefined> {
        return value ? (await this.projects.resolve(value)).name : undefined;
    }
}

function cloudReceipt(
    sessionId: string,
    runId: string,
    receipt: Awaited<ReturnType<CloudRuns['command']>>
): Record<string, unknown> {
    const trackedRun = receipt.command;
    return {
        session_id: sessionId,
        run_id: runId,
        input_id: trackedRun.id,
        after_sequence: receipt.after_sequence,
    };
}

async function accessibleTracked(
    cloud: CloudRuns,
    project?: string
): Promise<ReturnType<CloudRuns['tracked']>> {
    const candidates = cloud
        .tracked()
        .filter((tracked) => !project || tracked.project === project);
    const accessible = await Promise.all(
        candidates.map((tracked) => cloud.available(tracked.organization))
    );
    return candidates.filter((_tracked, index) => accessible[index]);
}

function pendingRequest(request: PendingRunRequest): Record<string, unknown> {
    const details = request.details;
    if (request.kind === 'question') {
        const questions = Array.isArray(details.questions) ? details.questions : [];
        return {
            id: request.id,
            kind: request.kind,
            text: questions
                .flatMap((question) =>
                    isRecord(question) && typeof question.question === 'string'
                        ? [question.question]
                        : []
                )
                .join('\n'),
            options: questions.map((question) =>
                isRecord(question) && Array.isArray(question.options)
                    ? question.options
                    : []
            ),
        };
    }
    return {
        id: request.id,
        kind: request.kind,
        text:
            typeof details.message === 'string'
                ? details.message
                : typeof details.instructions === 'string'
                  ? details.instructions
                  : '',
        options: Array.isArray(details.options) ? details.options : [],
    };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
