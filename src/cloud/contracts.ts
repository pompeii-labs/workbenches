import { RowReader } from '../database/rows.js';
import {
    WORKBENCH_EVENT_TYPES,
    type WorkbenchEvent,
    type WorkbenchEventType,
} from '../runs/events.js';

export type CloudRunStatus =
    | 'queued'
    | 'provisioning'
    | 'starting'
    | 'running'
    | 'needs_input'
    | 'completing'
    | 'completed'
    | 'failed'
    | 'cancelled';

export interface CloudRun {
    id: string;
    session_id: string;
    project: { slug: string; name: string } | null;
    workbench: { slug: string; organization_slug: string };
    version: { version: string };
    kind: 'initial' | 'continuation';
    status: CloudRunStatus;
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
    updated_at: string;
}

export interface CloudCommandReceipt {
    command: {
        id: string;
        kind: 'send' | 'steer' | 'queue' | 'answer' | 'cancel';
        status: 'pending' | 'claimed' | 'delivered' | 'rejected';
        reason: string | null;
    };
    after_sequence: number;
}

export function parseCloudRun(value: unknown): CloudRun {
    if (!isRecord(value) || !isRecord(value.workbench) || !isRecord(value.version))
        return malformed('run');
    const status = value.status;
    const kind = value.kind;
    const usage = value.usage;
    const project = value.project ?? null;
    if (
        !textFields(value, ['id', 'session_id', 'task', 'created_at', 'updated_at']) ||
        !textFields(value.workbench, ['slug', 'organization_slug']) ||
        !textFields(value.version, ['version']) ||
        (project !== null &&
            (!isRecord(project) || !textFields(project, ['slug', 'name']))) ||
        !cloudStatus(status) ||
        (kind !== 'initial' && kind !== 'continuation') ||
        !nullableText(value.final_response) ||
        !nullableText(value.terminal_reason) ||
        !nullableText(value.started_at) ||
        !nullableText(value.completed_at) ||
        (value.outcome_size !== null && !nonNegative(value.outcome_size)) ||
        (usage !== null && !parseUsage(usage))
    )
        return malformed('run');
    return {
        id: requiredText(value.id),
        session_id: requiredText(value.session_id),
        project:
            project === null
                ? null
                : {
                      slug: requiredText(project.slug),
                      name: requiredText(project.name),
                  },
        workbench: {
            slug: requiredText(value.workbench.slug),
            organization_slug: requiredText(value.workbench.organization_slug),
        },
        version: { version: requiredText(value.version.version) },
        kind,
        status,
        task: requiredText(value.task),
        final_response: value.final_response,
        terminal_reason: value.terminal_reason,
        usage: usage === null ? null : usage,
        outcome_size: value.outcome_size,
        created_at: requiredText(value.created_at),
        started_at: value.started_at,
        completed_at: value.completed_at,
        updated_at: requiredText(value.updated_at),
    };
}

export function parseCloudEvent(value: unknown): WorkbenchEvent {
    if (
        !isRecord(value) ||
        value.protocol !== 0 ||
        typeof value.run_id !== 'string' ||
        !Number.isSafeInteger(value.sequence) ||
        typeof value.sequence !== 'number' ||
        value.sequence < 1 ||
        typeof value.timestamp !== 'string' ||
        !eventType(value.type) ||
        typeof value.runner !== 'string' ||
        !isRecord(value.data)
    )
        return malformed('event');
    return {
        protocol: 0,
        run_id: value.run_id,
        sequence: value.sequence,
        timestamp: value.timestamp,
        type: value.type,
        runner: value.runner,
        data: value.data,
    };
}

export function parseCloudCommand(value: unknown): CloudCommandReceipt {
    if (!isRecord(value) || !isRecord(value.command)) return malformed('command');
    const command = value.command;
    const kind = commandKind(command.kind);
    const status = commandStatus(command.status);
    if (
        typeof command.id !== 'string' ||
        !kind ||
        !status ||
        !nullableText(command.reason) ||
        typeof value.after_sequence !== 'number' ||
        !Number.isSafeInteger(value.after_sequence) ||
        value.after_sequence < 0
    )
        return malformed('command');
    return {
        command: {
            id: command.id,
            kind,
            status,
            reason: command.reason,
        },
        after_sequence: value.after_sequence,
    };
}

/** Close code the cloud sends on a long-lived socket that must re-authenticate. */
export const CLOUD_REAUTHENTICATE_CLOSE = 4001;

export function isCloudTerminal(status: CloudRunStatus): boolean {
    return status === 'completed' || status === 'failed' || status === 'cancelled';
}

function parseUsage(value: unknown): value is NonNullable<CloudRun['usage']> {
    return (
        isRecord(value) &&
        nonNegativeInteger(value.input_tokens) &&
        nonNegativeInteger(value.output_tokens) &&
        (value.cost_usd === null || nonNegative(value.cost_usd))
    );
}

function cloudStatus(value: unknown): value is CloudRunStatus {
    return [
        'queued',
        'provisioning',
        'starting',
        'running',
        'needs_input',
        'completing',
        'completed',
        'failed',
        'cancelled',
    ].includes(String(value));
}

function eventType(value: unknown): value is WorkbenchEventType {
    return WORKBENCH_EVENT_TYPES.some((type) => type === value);
}

function textFields(
    value: Record<string, unknown>,
    names: string[]
): value is Record<string, unknown> & Record<string, string> {
    return names.every((name) => typeof value[name] === 'string');
}

function requiredText(value: unknown): string {
    if (typeof value !== 'string') return malformed('run');
    return value;
}

function commandKind(
    value: unknown
): CloudCommandReceipt['command']['kind'] | undefined {
    return value === 'send' ||
        value === 'steer' ||
        value === 'queue' ||
        value === 'answer' ||
        value === 'cancel'
        ? value
        : undefined;
}

function commandStatus(
    value: unknown
): CloudCommandReceipt['command']['status'] | undefined {
    return value === 'pending' ||
        value === 'claimed' ||
        value === 'delivered' ||
        value === 'rejected'
        ? value
        : undefined;
}

function nullableText(value: unknown): value is string | null {
    return value === null || typeof value === 'string';
}

function nonNegative(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function nonNegativeInteger(value: unknown): value is number {
    return nonNegative(value) && Number.isSafeInteger(value);
}

function malformed(kind: string): never {
    throw new Error(`The Workbench cloud API returned a malformed ${kind}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return RowReader.isRecord(value);
}
