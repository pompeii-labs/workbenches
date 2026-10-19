import { readFile } from 'node:fs/promises';

import packageMetadata from '../../package.json' with { type: 'json' };
import type { ProjectRecord } from '../database/projects.js';
import type { RunOutcome } from '../outcomes/contracts.js';
import { outcomeArtifactPath } from '../outcomes/paths.js';
import type { OutcomeStore } from '../outcomes/store.js';
import type { ProjectStore } from '../projects/store.js';
import type { RunStore, StoredRun } from '../runs/store.js';
import type { RunSupervision } from '../runs/supervision.js';
import type { SessionStore, StoredSession } from '../sessions/store.js';
import type {
    StudioColumn,
    StudioEventsPage,
    StudioOutcomeFile,
    StudioProject,
    StudioRun,
    StudioTask,
} from './contracts.js';
import { artifactBytes, isRecord, text } from './values.js';
import {
    activityFrom,
    statusFrom,
    type TaskView,
    taskFrom,
    usageFrom,
    waitingFrom,
} from './views/local.js';

/**
 * The Studio board: tracked local sessions grouped into projects, with their
 * runs, events, and outcome files.
 */
export class StudioBoard {
    constructor(
        private readonly runs: Pick<RunStore, 'list' | 'read' | 'readEvents'>,
        private readonly sessions: Pick<SessionStore, 'list' | 'read'>,
        private readonly supervision: Pick<RunSupervision, 'snapshot'>,
        private readonly outcomes: Pick<
            OutcomeStore,
            'findFinalByRun' | 'artifactPath'
        >,
        private readonly projectStore: Pick<ProjectStore, 'list' | 'resolve'>
    ) {}

    status(): { version: string } {
        return { version: packageMetadata.version };
    }

    async tasks(project?: string): Promise<StudioTask[]> {
        return (await this.views(project)).map((view) => view.task);
    }

    async task(id: string): Promise<{ task: StudioTask; runs: StudioRun[] }> {
        const session = await this.trackedSession(id);
        const runs = (await this.runs.list())
            .filter((run) => run.session_id === session.id)
            .toSorted((left, right) =>
                left.dispatched_at.localeCompare(right.dispatched_at)
            );
        return {
            task: await this.taskFrom(
                session,
                await this.runs.read(session.latest_run_id)
            ),
            runs: await Promise.all(runs.map((run) => this.runFrom(run))),
        };
    }

    async run(id: string): Promise<StudioRun> {
        const run = await this.runs.read(id);
        await this.trackedSession(run.session_id ?? run.id);
        return this.runFrom(run);
    }

    async events(id: string, after: number, limit: number): Promise<StudioEventsPage> {
        const run = await this.runs.read(id);
        await this.trackedSession(run.session_id ?? run.id);
        const events = (await this.runs.readEvents(id))
            .filter((event) => event.sequence > after)
            .slice(0, limit);
        return { events, next: events.at(-1)?.sequence ?? after };
    }

    async projects(): Promise<StudioProject[]> {
        const views = await this.views();
        const projects = await Promise.all(
            this.projectStore.list().map((project) => this.projectFrom(project, views))
        );
        return projects.toSorted((left, right) => {
            const leftHasTasks = Object.values(left.counts).some((count) => count > 0);
            const rightHasTasks = Object.values(right.counts).some(
                (count) => count > 0
            );
            if (leftHasTasks !== rightHasTasks) return leftHasTasks ? -1 : 1;
            return right.updated_at.localeCompare(left.updated_at);
        });
    }

    async project(name: string): Promise<StudioProject | undefined> {
        let project: ProjectRecord;
        try {
            project = this.projectStore.resolve(name);
        } catch {
            return undefined;
        }
        return this.projectFrom(project, await this.views(project.name));
    }

    async outcomeFiles(runId: string): Promise<StudioOutcomeFile[]> {
        const run = await this.runs.read(runId);
        await this.trackedSession(run.session_id ?? run.id);
        const outcome = await this.outcomes.findFinalByRun(runId);
        return (
            outcome?.artifacts.map((artifact) => ({
                path: outcomeArtifactPath(artifact),
                name: artifact.name,
                media_type: artifact.content.media_type,
                size: artifact.content.size_bytes,
                description: artifact.description ?? null,
            })) ?? []
        );
    }

    async outcomeFile(
        runId: string,
        path: string
    ): Promise<{ bytes: Uint8Array; mediaType: string }> {
        const run = await this.runs.read(runId);
        await this.trackedSession(run.session_id ?? run.id);
        const outcome = await this.outcomes.findFinalByRun(runId);
        const artifact = outcome?.artifacts.find(
            (candidate) => outcomeArtifactPath(candidate) === path
        );
        if (!outcome || !artifact) throw new Error('Outcome file does not exist');
        return {
            bytes: await readFile(
                await this.outcomes.artifactPath(outcome.id, artifact.id)
            ),
            mediaType: artifact.content.media_type,
        };
    }

    private async views(project?: string): Promise<TaskView[]> {
        const sessions = (await this.sessions.list()).filter(
            (session) => session.project && (!project || session.project === project)
        );
        const views = await Promise.all(
            sessions.map(async (session) => {
                const run = await this.runs.read(session.latest_run_id);
                const [snapshot, events] = await Promise.all([
                    this.supervision.snapshot(run),
                    this.runs.readEvents(run.id),
                ]);
                return {
                    session,
                    run,
                    snapshot,
                    events,
                    task: taskFrom(session, run, snapshot, events),
                };
            })
        );
        return views.toSorted((left, right) =>
            right.task.updated_at.localeCompare(left.task.updated_at)
        );
    }

    private async trackedSession(id: string): Promise<StoredSession> {
        const session = await this.sessions.read(id).catch(() => undefined);
        if (!session?.project) throw new Error('Studio task does not exist');
        return session;
    }

    private async taskFrom(
        session: StoredSession,
        run: StoredRun
    ): Promise<StudioTask> {
        const [snapshot, events] = await Promise.all([
            this.supervision.snapshot(run),
            this.runs.readEvents(run.id),
        ]);
        return taskFrom(session, run, snapshot, events);
    }

    private async runFrom(run: StoredRun): Promise<StudioRun> {
        const [snapshot, events] = await Promise.all([
            this.supervision.snapshot(run),
            this.runs.readEvents(run.id),
        ]);
        const usage = usageFrom(snapshot.usage_total);
        const terminal = events
            .toReversed()
            .find((event) => ['run.failed', 'run.cancelled'].includes(event.type));
        const terminalData = isRecord(terminal?.data) ? terminal.data : {};
        return {
            id: run.id,
            session_id: run.session_id ?? run.id,
            status: statusFrom(run, snapshot),
            task: run.task ?? '',
            final_response: snapshot.final || null,
            terminal_reason:
                text(terminalData.message) || text(terminalData.reason) || null,
            usage,
            outcome_size: artifactBytes(await this.finalArtifacts(run)),
            created_at: run.dispatched_at,
            started_at: run.started_at ?? null,
            completed_at: run.finished_at ?? null,
        };
    }

    private async finalArtifacts(run: StoredRun): Promise<RunOutcome['artifacts']> {
        if (!run.outcome_id) return [];
        const outcome = await this.outcomes
            .findFinalByRun(run.id)
            .catch(() => undefined);
        return outcome?.artifacts ?? [];
    }

    private async projectFrom(
        project: ProjectRecord,
        all: TaskView[]
    ): Promise<StudioProject> {
        const views = all.filter((view) => view.session.project === project.name);
        const counts: Record<StudioColumn, number> = {
            needs_you: 0,
            running: 0,
            done: 0,
            failed: 0,
        };
        for (const view of views) counts[view.task.column] += 1;
        const done = views.find((view) => view.task.column === 'done');
        const start = new Date();
        start.setHours(0, 0, 0, 0);
        const sessionIds = new Set(views.map((view) => view.session.id));
        const today = (await this.runs.list()).filter(
            (run) =>
                run.session_id !== undefined &&
                sessionIds.has(run.session_id) &&
                Date.parse(run.dispatched_at) >= +start
        );
        const totals = await Promise.all(
            today.map(async (run) =>
                usageFrom((await this.supervision.snapshot(run)).usage_total)
            )
        );
        const costs = totals.flatMap((usage) =>
            usage?.cost_usd === null || usage?.cost_usd === undefined
                ? []
                : [usage.cost_usd]
        );
        return {
            name: project.name,
            slug: project.slug,
            counts,
            updated_at: views[0]?.task.updated_at ?? project.created_at,
            created_at: project.created_at,
            now: views
                .filter((view) => view.task.column === 'running')
                .flatMap(activityFrom)
                .toSorted((left, right) => right.at.localeCompare(left.at))
                .slice(0, 3),
            waiting: views
                .filter((view) => view.task.needs_input)
                .flatMap(waitingFrom)
                .toSorted((left, right) => left.at.localeCompare(right.at)),
            latest_done: done
                ? {
                      task_id: done.task.id,
                      latest_run_id: done.task.latest_run_id,
                      title: done.task.title,
                      at: done.task.updated_at,
                      has_outcome: (await this.finalArtifacts(done.run)).length > 0,
                  }
                : null,
            today: {
                runs: today.length,
                tokens: totals.reduce(
                    (sum, usage) =>
                        sum + (usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0),
                    0
                ),
                cost_usd: costs.length
                    ? costs.reduce((sum, cost) => sum + cost, 0)
                    : null,
            },
        };
    }
}
