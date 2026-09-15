import { stripVTControlCharacters } from 'node:util';

export interface ToolDescription {
    title: string;
    target?: string;
    description?: string;
}

export function describeTool(
    name: string,
    input: Record<string, unknown> | undefined,
    metadata: Record<string, unknown> | undefined
): ToolDescription {
    const normalized = name.trim().toLowerCase();
    const target = path(input) ?? url(input);
    const description = value(input, 'description');

    if (['bash', 'shell', 'shell_command'].includes(normalized)) {
        return { title: description ?? 'Shell command' };
    }
    if (normalized === 'read') return withTarget('Read', target, range(input));
    if (['write', 'edit'].includes(normalized)) {
        return withTarget(humanize(normalized), target);
    }
    if (['apply_patch', 'patch'].includes(normalized)) {
        const files = count(metadata, 'files');
        return {
            title: 'Patch',
            ...(files === undefined
                ? {}
                : { description: `${files} ${files === 1 ? 'file' : 'files'}` }),
        };
    }
    if (normalized === 'glob') {
        return withTarget(
            queryTitle('Glob', value(input, 'pattern')),
            target,
            matches(metadata)
        );
    }
    if (normalized === 'grep') {
        return withTarget(
            queryTitle('Grep', value(input, 'pattern')),
            target,
            matches(metadata)
        );
    }
    if (['list', 'ls'].includes(normalized)) return withTarget('List', target);
    if (['webfetch', 'web_fetch'].includes(normalized)) {
        return withTarget('Fetch', url(input));
    }
    if (['websearch', 'web_search'].includes(normalized)) {
        return { title: queryTitle('Search', value(input, 'query')) };
    }
    if (['task', 'agent'].includes(normalized)) {
        const agent = value(input, 'subagent_type');
        return {
            title: description ?? (agent ? `${humanize(agent)} task` : 'Task'),
            ...(description && agent
                ? { description: `${humanize(agent)} agent` }
                : {}),
        };
    }
    if (['todowrite', 'todo_write'].includes(normalized)) {
        const todos = Array.isArray(input?.todos) ? input.todos.length : undefined;
        return {
            title: 'Update todos',
            ...(todos === undefined
                ? {}
                : { description: `${todos} ${todos === 1 ? 'item' : 'items'}` }),
        };
    }
    if (normalized === 'skill') {
        return { title: queryTitle('Skill', value(input, 'name')) };
    }
    return {
        title: humanize(name || 'Tool'),
        ...(description ? { description } : {}),
        ...(target ? { target } : {}),
    };
}

function withTarget(
    title: string,
    target: string | undefined,
    description?: string
): ToolDescription {
    return {
        title,
        ...(target ? { target } : {}),
        ...(description ? { description } : {}),
    };
}

function path(input: Record<string, unknown> | undefined): string | undefined {
    return value(input, 'filePath') ?? value(input, 'path');
}

function url(input: Record<string, unknown> | undefined): string | undefined {
    return value(input, 'url');
}

function range(input: Record<string, unknown> | undefined): string | undefined {
    const offset = number(input, 'offset');
    const limit = number(input, 'limit');
    if (offset === undefined && limit === undefined) return undefined;
    if (offset !== undefined && limit !== undefined) {
        return `lines ${offset}-${offset + Math.max(0, limit - 1)}`;
    }
    return offset !== undefined ? `from line ${offset}` : `${limit} lines`;
}

function matches(metadata: Record<string, unknown> | undefined): string | undefined {
    const total = number(metadata, 'matches') ?? number(metadata, 'count');
    return total === undefined
        ? undefined
        : `${total} ${total === 1 ? 'match' : 'matches'}`;
}

function count(
    metadata: Record<string, unknown> | undefined,
    key: string
): number | undefined {
    const candidate = metadata?.[key];
    return Array.isArray(candidate) ? candidate.length : number(metadata, key);
}

function queryTitle(action: string, query: string | undefined): string {
    return query ? `${action} "${query}"` : action;
}

function value(
    record: Record<string, unknown> | undefined,
    key: string
): string | undefined {
    const candidate = record?.[key];
    if (typeof candidate !== 'string') return undefined;
    const clean = sanitize(candidate).trim();
    if (!clean) return undefined;
    return clean.length > 240 ? `${clean.slice(0, 237)}...` : clean;
}

function number(
    record: Record<string, unknown> | undefined,
    key: string
): number | undefined {
    const candidate = record?.[key];
    return typeof candidate === 'number' && Number.isFinite(candidate)
        ? candidate
        : undefined;
}

function sanitize(value: string): string {
    return Array.from(stripVTControlCharacters(value))
        .filter((character) => {
            const code = character.charCodeAt(0);
            return (
                code === 9 ||
                code === 10 ||
                code === 13 ||
                (code >= 32 && !(code >= 127 && code <= 159))
            );
        })
        .join('')
        .replace(/\s+/gu, ' ');
}

function humanize(value: string): string {
    const normalized = value.replaceAll('_', ' ').replaceAll('-', ' ').trim();
    return normalized
        .split(/\s+/u)
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(' ');
}
