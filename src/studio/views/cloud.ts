import type {
    CloudRun,
    CloudRunStatus,
    TrackedCloudSession,
} from '../../cloud/index.js';
import type { CloudProject, CloudProjectTask } from '../../projects/index.js';
import type { WorkbenchEvent } from '../../runs/events.js';
import type {
    StudioActivity,
    StudioOutcomeFile,
    StudioProject,
    StudioRun,
    StudioRunStatus,
    StudioTask,
    StudioWaiting,
} from '../contracts.js';
import { isRecord, oneLine, text } from '../values.js';

export interface CloudView {
    tracked: TrackedCloudSession;
    run: CloudRun;
    events: WorkbenchEvent[];
    task: StudioTask;
}

export type CloudProjectSummary = Pick<
    StudioProject,
    'counts' | 'updated_at' | 'now' | 'waiting' | 'latest_done' | 'today'
>;

export function runFrom(run: CloudRun): StudioRun {
    return {
        id: run.id,
        session_id: run.session_id,
        status: run.status,
        task: run.task,
        final_response: run.final_response,
        terminal_reason: run.terminal_reason,
        usage: run.usage,
        outcome_size: run.outcome_size,
        created_at: run.created_at,
        started_at: run.started_at,
        completed_at: run.completed_at,
    };
}

export function columnFrom(status: CloudRunStatus): StudioTask['column'] {
    if (status === 'needs_input') return 'needs_you';
    if (status === 'completed') return 'done';
    if (status === 'failed' || status === 'cancelled') return 'failed';
    return 'running';
}

export function cloudStatus(value: string): StudioRunStatus {
    if (
        value === 'queued' ||
        value === 'provisioning' ||
        value === 'starting' ||
        value === 'running' ||
        value === 'needs_input' ||
        value === 'completing' ||
        value === 'completed' ||
        value === 'failed' ||
        value === 'cancelled'
    )
        return value;
    throw new Error('The Workbench cloud API returned a malformed project task');
}

export function trackedTaskFrom(
    tracked: TrackedCloudSession,
    run: CloudRun,
    events: WorkbenchEvent[]
): StudioTask {
    return {
        id: tracked.sessionId,
        project: tracked.project,
        source: 'cloud',
        title: tracked.title,
        workbench: {
            name: `${run.workbench.organization_slug}/${run.workbench.slug}`,
            version: run.version.version,
        },
        status: run.status,
        column: columnFrom(run.status),
        latest_run_id: run.id,
        needs_input: run.status === 'needs_input',
        created_at: tracked.createdAt,
        updated_at: events.at(-1)?.timestamp ?? run.updated_at,
    };
}

export function cloudProjectSummary(
    project: CloudProject | undefined,
    views: CloudView[]
): CloudProjectSummary | null {
    const tracked = trackedSummary(views);
    if (!project) return tracked;
    const cloud: CloudProjectSummary = {
        counts: project.counts,
        updated_at: project.updated_at,
        now: project.now,
        waiting: project.waiting,
        latest_done: project.latest_done,
        today: project.today,
    };
    if (!tracked) return cloud;
    return {
        counts: {
            needs_you: cloud.counts.needs_you + tracked.counts.needs_you,
            running: cloud.counts.running + tracked.counts.running,
            done: cloud.counts.done + tracked.counts.done,
            failed: cloud.counts.failed + tracked.counts.failed,
        },
        updated_at:
            cloud.updated_at > tracked.updated_at
                ? cloud.updated_at
                : tracked.updated_at,
        now: [...cloud.now, ...tracked.now]
            .toSorted((left, right) => right.at.localeCompare(left.at))
            .slice(0, 3),
        waiting: [...cloud.waiting, ...tracked.waiting].toSorted((left, right) =>
            left.at.localeCompare(right.at)
        ),
        latest_done: latestCompletion(cloud.latest_done, tracked.latest_done),
        today: {
            runs: cloud.today.runs + tracked.today.runs,
            tokens: cloud.today.tokens + tracked.today.tokens,
            cost_usd: sumCost(cloud.today.cost_usd, tracked.today.cost_usd),
        },
    };
}

export function parseOutcomeFile(value: unknown): StudioOutcomeFile {
    if (
        !isRecord(value) ||
        typeof value.path !== 'string' ||
        typeof value.name !== 'string' ||
        typeof value.media_type !== 'string' ||
        typeof value.size !== 'number' ||
        !Number.isSafeInteger(value.size) ||
        value.size < 0 ||
        (value.description !== null && typeof value.description !== 'string')
    )
        throw new Error('The Workbench cloud API returned a malformed outcome file');
    return {
        path: value.path,
        name: value.name,
        media_type: value.media_type,
        size: value.size,
        description: value.description,
    };
}

export function activityFrom(view: CloudView): StudioActivity[] {
    const event = view.events
        .toReversed()
        .find(
            (candidate) =>
                candidate.type === 'output.text' || candidate.type === 'tool.started'
        );
    if (!event || !isRecord(event.data)) return [];
    const value =
        event.type === 'output.text'
            ? text(event.data.text)
            : text(event.data.title) || text(event.data.name);
    return value
        ? [
              {
                  task_id: view.task.id,
                  latest_run_id: view.task.latest_run_id,
                  title: view.task.title,
                  workbench: view.task.workbench.name,
                  source: 'cloud',
                  text: oneLine(value),
                  at: event.timestamp,
              },
          ]
        : [];
}

export function waitingFrom(view: CloudView): StudioWaiting[] {
    const event = view.events
        .toReversed()
        .find(
            (candidate) =>
                candidate.type === 'input.requested' ||
                candidate.type === 'question.requested'
        );
    if (!event || !isRecord(event.data)) return [];
    const questions = Array.isArray(event.data.questions) ? event.data.questions : [];
    const question = isRecord(questions[0]) ? text(questions[0].question) : '';
    return [
        {
            task_id: view.task.id,
            latest_run_id: view.task.latest_run_id,
            title: view.task.title,
            text: oneLine(question || text(event.data.message) || 'Input waiting'),
            at: event.timestamp,
        },
    ];
}

export function count(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export function terminalEvent(event: WorkbenchEvent): boolean {
    return (
        event.type === 'run.completed' ||
        event.type === 'run.failed' ||
        event.type === 'run.cancelled'
    );
}

export function foldRun(run: CloudRun, events: WorkbenchEvent[]): void {
    for (const event of events) applyEvent(run, events, event);
}

export function applyEvent(
    run: CloudRun,
    events: WorkbenchEvent[],
    event: WorkbenchEvent
): void {
    run.updated_at = event.timestamp;
    if (event.type === 'run.started') run.status = 'running';
    if (event.type === 'input.requested' || event.type === 'question.requested')
        run.status = 'needs_input';
    if (
        event.type === 'input.accepted' ||
        event.type === 'question.answered' ||
        event.type === 'question.rejected'
    )
        run.status = hasPending(events) ? 'needs_input' : 'running';
    if (event.type === 'run.completed') run.status = 'completed';
    if (event.type === 'run.failed') run.status = 'failed';
    if (event.type === 'run.cancelled') run.status = 'cancelled';
    if (terminalEvent(event) && run.completed_at === null)
        run.completed_at = event.timestamp;
    if (event.type === 'outcome.available' && run.outcome_size === null)
        run.outcome_size = 0;
}

export function taskFrom(task: CloudProjectTask): StudioTask {
    return {
        id: task.id,
        project: task.project.name,
        source: 'cloud',
        title: task.title,
        workbench: task.workbench,
        status: cloudStatus(task.status),
        column: task.column,
        latest_run_id: task.latest_run_id,
        needs_input: task.needs_input,
        created_at: task.created_at,
        updated_at: task.updated_at,
    };
}

export function sameProject(left: string, right: string): boolean {
    return left.localeCompare(right, undefined, { sensitivity: 'accent' }) === 0;
}

export function frameTask(task: StudioTask, slug: string): CloudProjectTask {
    return {
        ...task,
        project: { name: task.project, slug },
        source: 'cloud',
    };
}

function hasPending(events: WorkbenchEvent[]): boolean {
    const resolved = new Set(
        events.flatMap((event) =>
            (event.type === 'input.accepted' ||
                event.type === 'question.answered' ||
                event.type === 'question.rejected') &&
            isRecord(event.data) &&
            typeof event.data.id === 'string'
                ? [event.data.id]
                : []
        )
    );
    return events.some(
        (event) =>
            (event.type === 'input.requested' || event.type === 'question.requested') &&
            isRecord(event.data) &&
            typeof event.data.id === 'string' &&
            !resolved.has(event.data.id)
    );
}

function trackedSummary(views: CloudView[]): CloudProjectSummary | null {
    if (views.length === 0) return null;
    const counts = { needs_you: 0, running: 0, done: 0, failed: 0 };
    for (const view of views) counts[view.task.column] += 1;
    const done = views
        .filter((view) => view.task.column === 'done')
        .toSorted((left, right) =>
            right.task.updated_at.localeCompare(left.task.updated_at)
        )[0];
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const today = views.filter((view) => Date.parse(view.run.created_at) >= +start);
    const costs = today.flatMap((view) =>
        view.run.usage?.cost_usd === null || view.run.usage?.cost_usd === undefined
            ? []
            : [view.run.usage.cost_usd]
    );
    return {
        counts,
        updated_at:
            views
                .map((view) => view.task.updated_at)
                .toSorted()
                .at(-1) ?? new Date(0).toISOString(),
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
                  has_outcome: done.run.outcome_size !== null,
              }
            : null,
        today: {
            runs: today.length,
            tokens: today.reduce(
                (sum, view) =>
                    sum +
                    (view.run.usage?.input_tokens ?? 0) +
                    (view.run.usage?.output_tokens ?? 0),
                0
            ),
            cost_usd: costs.length ? costs.reduce((sum, cost) => sum + cost, 0) : null,
        },
    };
}

function latestCompletion(
    left: CloudProjectSummary['latest_done'],
    right: CloudProjectSummary['latest_done']
): CloudProjectSummary['latest_done'] {
    if (!left) return right;
    if (!right) return left;
    return left.at >= right.at ? left : right;
}

function sumCost(left: number | null, right: number | null): number | null {
    return left === null && right === null ? null : (left ?? 0) + (right ?? 0);
}
