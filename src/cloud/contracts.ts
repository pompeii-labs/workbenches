import { RegistryClient } from '../registry/client.js';
import { WORKBENCH_EVENT_TYPES, type WorkbenchEvent } from '../runs/events.js';

export interface CloudRun {
    id: string;
    session_id: string;
    status: string;
    workbench: { slug: string; organization_slug: string };
    version: { version: string };
    final_response: string | null;
    terminal_reason: string | null;
    created_at: string;
}

export interface CloudEvent extends Omit<WorkbenchEvent, 'type'> {
    type: string;
}

export interface CloudFile {
    path: string;
    name: string;
    media_type: string;
    size: number;
    description?: string;
    url: string;
}

export interface CloudFiles {
    files: CloudFile[];
    archive_url: string;
}

export function standardEvent(event: CloudEvent): event is WorkbenchEvent {
    return WORKBENCH_EVENT_TYPES.some((type) => type === event.type);
}

export function parseEvent(value: unknown, id: string): CloudEvent {
    if (
        !RegistryClient.isRecord(value) ||
        value.protocol !== 0 ||
        value.run_id !== id ||
        typeof value.sequence !== 'number' ||
        !Number.isSafeInteger(value.sequence) ||
        value.sequence < 1 ||
        typeof value.timestamp !== 'string' ||
        typeof value.type !== 'string' ||
        typeof value.runner !== 'string' ||
        !RegistryClient.isRecord(value.data)
    )
        throw new Error('The cloud API returned a malformed Workbench event');
    return {
        protocol: 0,
        run_id: id,
        sequence: value.sequence,
        timestamp: value.timestamp,
        type: value.type,
        runner: value.runner,
        data: value.data,
    };
}

export function parseRun(value: unknown): CloudRun {
    if (
        !RegistryClient.isRecord(value) ||
        typeof value.id !== 'string' ||
        typeof value.session_id !== 'string' ||
        typeof value.status !== 'string' ||
        !RegistryClient.isRecord(value.workbench) ||
        typeof value.workbench.slug !== 'string' ||
        typeof value.workbench.organization_slug !== 'string' ||
        !RegistryClient.isRecord(value.version) ||
        typeof value.version.version !== 'string' ||
        (value.final_response !== null && typeof value.final_response !== 'string') ||
        (value.terminal_reason !== null && typeof value.terminal_reason !== 'string') ||
        typeof value.created_at !== 'string'
    )
        throw new Error('The cloud API returned a malformed run');
    return {
        id: value.id,
        session_id: value.session_id,
        status: value.status,
        workbench: {
            slug: value.workbench.slug,
            organization_slug: value.workbench.organization_slug,
        },
        version: { version: value.version.version },
        final_response: value.final_response,
        terminal_reason: value.terminal_reason,
        created_at: value.created_at,
    };
}

export function terminal(
    status: string
): status is 'completed' | 'failed' | 'cancelled' {
    return status === 'completed' || status === 'failed' || status === 'cancelled';
}
