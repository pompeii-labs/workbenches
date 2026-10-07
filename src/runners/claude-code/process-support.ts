import type { SpawnedRunner } from '../../types.js';

export function asError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}

export function signal(child: SpawnedRunner, value: 'SIGTERM' | 'SIGKILL'): void {
    if (child.kill) Reflect.apply(child.kill, child, [value]);
}

export async function settlesWithin(
    promise: Promise<void>,
    milliseconds: number
): Promise<boolean> {
    return (
        (await within(
            promise.then(() => true),
            milliseconds
        )) ?? false
    );
}

export async function within<T>(
    promise: Promise<T>,
    milliseconds: number
): Promise<T | undefined> {
    let cancel = () => {};
    const timeout = new Promise<undefined>((resolve) => {
        const timer = setTimeout(resolve, milliseconds);
        cancel = () => clearTimeout(timer);
    });
    try {
        return await Promise.race([promise, timeout]);
    } finally {
        cancel();
    }
}

export async function consumeLines(
    stream: ReadableStream<Uint8Array> | undefined,
    consume: (line: string) => Promise<void>
): Promise<void> {
    if (!stream) return;
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    for (;;) {
        const next = await reader.read();
        if (next.done) break;
        pending += decoder.decode(next.value, { stream: true });
        if (pending.length > 16 * 1024 * 1024) {
            throw new Error('Claude Code emitted an oversized JSON event');
        }
        const lines = pending.split('\n');
        pending = lines.pop() ?? '';
        for (const line of lines) {
            const normalized = line.endsWith('\r') ? line.slice(0, -1) : line;
            if (normalized.trim()) await consume(normalized);
        }
    }
    pending += decoder.decode();
    if (pending.trim()) await consume(pending);
}

export function record(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value))
        : undefined;
}

export function string(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function strings(value: unknown): string[] {
    return Array.isArray(value)
        ? value.filter((entry): entry is string => typeof entry === 'string')
        : [];
}

export function ignoredNativeMessage(message: Record<string, unknown>): boolean {
    if (message.type === 'rate_limit_event') return true;
    if (message.type !== 'system') return false;
    const subtype = string(message.subtype);
    if (!subtype) return false;
    return new Set([
        'thinking_tokens',
        'hook_started',
        'hook_response',
        'task_started',
        'task_updated',
        'task_notification',
        'background_tasks_changed',
    ]).has(subtype);
}
