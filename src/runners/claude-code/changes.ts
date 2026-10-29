import type { ToolDetails } from '../details.js';
import type { PatchHunk } from '../diff.js';

type PatchFields = ReturnType<ToolDetails['patch']>;

/**
 * The patch of a Claude Code Write, Edit, or MultiEdit, from the tool's own
 * data: the `structuredPatch` its result reports, a created file's content,
 * or the content against the `originalFile` it reports. Without them, the
 * run's last write of the file stands in for the file before. A notebook edit
 * changes JSON cells, so it has no patch here; the host computes it from the
 * workspace.
 */
export function claudeCodePatch(
    details: ToolDetails,
    name: string,
    path: string,
    input: Record<string, unknown> | undefined,
    result: Record<string, unknown> | undefined
): PatchFields {
    const tool = name.toLowerCase();
    const hunks = structuredPatch(result?.structuredPatch);
    const original =
        typeof result?.originalFile === 'string' ? result.originalFile : undefined;
    if (tool === 'write') {
        const content =
            typeof input?.content === 'string'
                ? input.content
                : typeof result?.content === 'string'
                  ? result.content
                  : undefined;
        if (content === undefined) {
            details.forget(path);
            return hunks ? details.hunks(path, hunks) : {};
        }
        if (hunks) {
            details.remember(path, content);
            return details.hunks(path, hunks);
        }
        return details.written(
            path,
            content,
            result?.type === 'create' ? '' : original
        );
    }
    if (tool !== 'edit' && tool !== 'multiedit') {
        details.forget(path);
        return {};
    }
    const edits = claudeCodeEdits(tool, input);
    if (original !== undefined) details.remember(path, original);
    const edited = edits ? details.edited(path, edits) : undefined;
    if (!edits) details.forget(path);
    if (hunks) return details.hunks(path, hunks);
    return edited ? details.diff(path, edited.before, edited.after) : {};
}

function claudeCodeEdits(
    tool: string,
    input: Record<string, unknown> | undefined
): { oldText: string; newText: string; replaceAll: boolean }[] | undefined {
    const list =
        tool === 'multiedit' && Array.isArray(input?.edits) ? input.edits : [input];
    const edits = list.flatMap((entry) => {
        if (entry === null || typeof entry !== 'object' || Array.isArray(entry))
            return [];
        const oldText = Reflect.get(entry, 'old_string');
        const newText = Reflect.get(entry, 'new_string');
        return typeof oldText === 'string' && typeof newText === 'string'
            ? [
                  {
                      oldText,
                      newText,
                      replaceAll: Reflect.get(entry, 'replace_all') === true,
                  },
              ]
            : [];
    });
    return edits.length > 0 && edits.length === list.length ? edits : undefined;
}

/** Claude Code's structured patch hunks, or undefined when there are none. */
function structuredPatch(value: unknown): PatchHunk[] | undefined {
    if (!Array.isArray(value)) return undefined;
    const hunks = value.flatMap((entry): PatchHunk[] => {
        if (entry === null || typeof entry !== 'object' || Array.isArray(entry))
            return [];
        const oldStart = Reflect.get(entry, 'oldStart');
        const oldLines = Reflect.get(entry, 'oldLines');
        const newStart = Reflect.get(entry, 'newStart');
        const newLines = Reflect.get(entry, 'newLines');
        const lines = Reflect.get(entry, 'lines');
        if (
            !Number.isInteger(oldStart) ||
            !Number.isInteger(oldLines) ||
            !Number.isInteger(newStart) ||
            !Number.isInteger(newLines) ||
            !Array.isArray(lines) ||
            typeof oldStart !== 'number' ||
            typeof oldLines !== 'number' ||
            typeof newStart !== 'number' ||
            typeof newLines !== 'number'
        ) {
            return [];
        }
        return [
            {
                oldStart,
                oldLines,
                newStart,
                newLines,
                lines: lines.filter((line): line is string => typeof line === 'string'),
            },
        ];
    });
    return hunks.length > 0 ? hunks : undefined;
}

/**
 * The MCP server and tool behind a Claude Code tool name, which Claude Code
 * spells `mcp__<server>__<tool>`.
 */
export function claudeCodeMcp(
    name: string
): { server: string; tool: string } | undefined {
    const match = /^mcp__(.+?)__(.+)$/u.exec(name);
    return match?.[1] && match[2] ? { server: match[1], tool: match[2] } : undefined;
}
