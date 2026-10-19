import type { WorkbenchEvent } from '../runs/events.js';

export type StudioSource = 'local' | 'docker' | 'e2b' | 'daytona';
export type StudioColumn = 'needs_you' | 'running' | 'done' | 'failed';
export type StudioRunStatus =
    | 'queued'
    | 'provisioning'
    | 'starting'
    | 'running'
    | 'needs_input'
    | 'completing'
    | 'completed'
    | 'failed'
    | 'cancelled';

export interface StudioTask {
    id: string;
    project: string;
    source: StudioSource;
    title: string;
    workbench: { name: string; version: string };
    status: StudioRunStatus;
    column: StudioColumn;
    latest_run_id: string;
    needs_input: boolean;
    created_at: string;
    updated_at: string;
}

export interface StudioRun {
    id: string;
    session_id: string;
    status: StudioRunStatus;
    task: string;
    final_response: string | null;
    terminal_reason: string | null;
    usage: {
        input_tokens: number;
        output_tokens: number;
        cost_usd: number | null;
    } | null;
    outcome_size: number | null;
    created_at: string;
    started_at: string | null;
    completed_at: string | null;
}

export interface StudioActivity {
    task_id: string;
    latest_run_id: string;
    title: string;
    workbench: string;
    source: StudioSource;
    text: string;
    at: string;
}

export interface StudioWaiting {
    task_id: string;
    latest_run_id: string;
    title: string;
    text: string;
    at: string;
}

export interface StudioProject {
    name: string;
    slug: string;
    counts: Record<StudioColumn, number>;
    updated_at: string;
    created_at: string;
    now: StudioActivity[];
    waiting: StudioWaiting[];
    latest_done: {
        task_id: string;
        latest_run_id: string;
        title: string;
        at: string;
        has_outcome: boolean;
    } | null;
    today: { runs: number; tokens: number; cost_usd: number | null };
}

export interface StudioOutcomeFile {
    path: string;
    name: string;
    media_type: string;
    size: number;
    description: string | null;
}

export interface StudioEventsPage {
    events: WorkbenchEvent[];
    next: number;
}
