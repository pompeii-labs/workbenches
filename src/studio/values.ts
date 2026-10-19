import type { RunOutcome } from '../outcomes/contracts.js';

export function artifactBytes(artifacts: RunOutcome['artifacts']): number | null {
    return artifacts.length
        ? artifacts.reduce((sum, artifact) => sum + artifact.content.size_bytes, 0)
        : null;
}

export function oneLine(value: string, limit = 140): string {
    const line = value.replace(/\s+/g, ' ').trim();
    return line.length > limit ? `${line.slice(0, limit - 1).trimEnd()}…` : line;
}

export function text(value: unknown): string {
    return typeof value === 'string' ? value : '';
}

export function number(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
