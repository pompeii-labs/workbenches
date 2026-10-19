import type { WorkbenchEvent } from '../../runs/events.js';
import type { StoredRun } from '../../runs/store.js';
import type { PendingRunRequest, RunSnapshot } from '../../runs/supervision.js';
import type { StoredSession } from '../../sessions/store.js';
import type {
    StudioActivity,
    StudioColumn,
    StudioRun,
    StudioRunStatus,
    StudioSource,
    StudioTask,
    StudioWaiting,
} from '../contracts.js';
import { isRecord, number, oneLine, text } from '../values.js';

/** A local session in a project with its latest run, as Studio shows it. */
export interface TaskView {
    session: StoredSession;
    run: StoredRun;
    snapshot: RunSnapshot;
    events: WorkbenchEvent[];
    task: StudioTask;
}

export function taskFrom(
    session: StoredSession,
    run: StoredRun,
    snapshot: RunSnapshot,
    events: WorkbenchEvent[]
): StudioTask {
    const status = statusFrom(run, snapshot);
    return {
        id: session.id,
        project: trackedProject(session),
        source: sourceFrom(session.runtime),
        title: session.name ?? titleFrom(run.task ?? ''),
        workbench: { name: session.workbench, version: session.workbench_version },
        status,
        column: columnFrom(status),
        latest_run_id: run.id,
        needs_input: status === 'needs_input',
        created_at: session.created_at,
        updated_at: latestAt(run, events),
    };
}

export function statusFrom(run: StoredRun, snapshot: RunSnapshot): StudioRunStatus {
    if (run.status === 'dispatched') return 'queued';
    if (snapshot.state === 'needs_input') return 'needs_input';
    if (run.status === 'completed') return 'completed';
    if (run.status === 'failed') return 'failed';
    if (run.status === 'cancelled') return 'cancelled';
    return 'running';
}

function trackedProject(session: StoredSession): string {
    if (!session.project) throw new Error('Studio task does not exist');
    return session.project;
}

function columnFrom(status: StudioRunStatus): StudioColumn {
    if (status === 'needs_input') return 'needs_you';
    if (status === 'completed') return 'done';
    if (status === 'failed' || status === 'cancelled') return 'failed';
    return 'running';
}

function sourceFrom(runtime: string): StudioSource {
    return runtime === 'docker' || runtime === 'e2b' || runtime === 'daytona'
        ? runtime
        : 'local';
}

function titleFrom(task: string): string {
    const line =
        task
            .split('\n')
            .find((candidate) => candidate.trim())
            ?.trim() ?? '';
    return line.replace(/^#\s*/, '') || 'Untitled task';
}

function latestAt(run: StoredRun, events: WorkbenchEvent[]): string {
    return (
        run.finished_at ??
        events.at(-1)?.timestamp ??
        run.started_at ??
        run.dispatched_at
    );
}

export function usageFrom(value: Record<string, unknown>): StudioRun['usage'] {
    const input = number(value.input_tokens) ?? 0;
    const output = number(value.output_tokens) ?? 0;
    const cost = number(value.cost_usd);
    return input === 0 && output === 0 && cost === undefined
        ? null
        : { input_tokens: input, output_tokens: output, cost_usd: cost ?? null };
}

export function activityFrom(view: TaskView): StudioActivity[] {
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
                  source: view.task.source,
                  text: oneLine(value),
                  at: event.timestamp,
              },
          ]
        : [];
}

export function waitingFrom(view: TaskView): StudioWaiting[] {
    const request = view.snapshot.pending_requests[0];
    return request
        ? [
              {
                  task_id: view.task.id,
                  latest_run_id: view.task.latest_run_id,
                  title: view.task.title,
                  text: oneLine(requestText(request)),
                  at:
                      view.events.find((event) => event.sequence === request.sequence)
                          ?.timestamp ?? view.task.updated_at,
              },
          ]
        : [];
}

function requestText(request: PendingRunRequest): string {
    const details = request.details;
    if (request.kind === 'question') {
        const questions = Array.isArray(details.questions) ? details.questions : [];
        const first = isRecord(questions[0]) ? text(questions[0].question) : '';
        const more = questions.length - 1;
        const suffix = more > 0 ? ` (+${more} more)` : '';
        return first
            ? oneLine(first, 140 - suffix.length) + suffix
            : 'Question waiting';
    }
    const message = text(details.message) || text(details.prompt);
    if (message) return message;
    if (details.kind === 'permission') {
        const resources = Array.isArray(details.resources)
            ? details.resources.filter(
                  (resource): resource is string => typeof resource === 'string'
              )
            : [];
        const action = [text(details.action), ...resources].filter(Boolean).join(' ');
        if (action) return action;
    }
    return 'Input waiting';
}
