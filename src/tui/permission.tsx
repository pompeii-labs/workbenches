import type { RunnerPermissionRequest } from '../runners/session.js';
import type { WorkbenchEvent } from '../runs/index.js';
import { useTheme } from './theme/index.js';

interface PermissionPromptProps {
    request: RunnerPermissionRequest;
}

export function PermissionPrompt(props: PermissionPromptProps) {
    const { theme } = useTheme();
    return (
        <box
            height={5}
            border={true}
            borderStyle="rounded"
            borderColor={theme.yellow}
            backgroundColor={theme.panelRaised}
            paddingX={1}
            flexDirection="column"
        >
            <text fg={theme.yellow} wrapMode="word">
                ? {props.request.message}
            </text>
            <text fg={theme.faint}>
                y allow once
                {props.request.allowAlways ? ' · a always allow' : ''} · n deny
            </text>
        </box>
    );
}

export function permissionFromEvent(
    event: WorkbenchEvent
): RunnerPermissionRequest | undefined {
    if (event.type !== 'input.requested') return undefined;
    const data = object(event.data);
    const id = string(data?.id);
    const action = string(data?.action);
    const message = string(data?.message);
    if (!id || !action || !message) return undefined;
    return {
        id,
        action,
        message,
        resources: strings(data?.resources),
        allowAlways: strings(data?.options).includes('allow_always'),
    };
}

function object(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
}

function string(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function strings(value: unknown): string[] {
    return Array.isArray(value)
        ? value.filter((item): item is string => typeof item === 'string')
        : [];
}
