import type { ToolDetails } from '../details.js';
import { record, string } from './json.js';

type PatchFields = ReturnType<ToolDetails['patch']>;

/**
 * The patch of an OpenCode edit or write, from the tool's own data: an edit's
 * `filediff` or `diff` metadata, or a write's content against the file before
 * it, which is empty when the metadata says the file did not exist and the
 * run's last write of it otherwise. A write over a file the run never wrote
 * has no patch here; the host computes it from the workspace.
 */
export function openCodePatch(
    details: ToolDetails,
    name: string,
    path: string,
    input: Record<string, unknown> | undefined,
    metadata: Record<string, unknown> | undefined
): PatchFields {
    const tool = name.toLowerCase();
    if (tool === 'write') {
        const content = input?.content;
        if (typeof content !== 'string') return {};
        return details.written(
            path,
            content,
            metadata?.exists === false ? '' : undefined
        );
    }
    if (tool !== 'edit') return {};
    const oldText = string(input?.oldString);
    const newText = typeof input?.newString === 'string' ? input.newString : undefined;
    let edited: { before: string; after: string } | undefined;
    if (oldText !== undefined && newText !== undefined) {
        edited = details.edited(path, [
            { oldText, newText, replaceAll: input?.replaceAll === true },
        ]);
    } else {
        details.forget(path);
    }
    const diff = string(record(metadata?.filediff)?.patch) ?? string(metadata?.diff);
    if (diff) return details.unified(path, diff);
    return edited ? details.diff(path, edited.before, edited.after) : {};
}

/**
 * The MCP server and tool behind an OpenCode tool name. OpenCode names an MCP
 * tool `<server>_<tool>`, with every character outside `[A-Za-z0-9_-]` of
 * each replaced by `_`, so the name is matched against the Workbench's
 * declared servers, longest first.
 */
export function openCodeMcp(
    name: string,
    servers: readonly string[]
): { server: string; tool: string } | undefined {
    const candidates = servers
        .map((server) => ({ server, prefix: `${sanitize(server)}_` }))
        .toSorted((left, right) => right.prefix.length - left.prefix.length);
    for (const candidate of candidates) {
        if (
            name.startsWith(candidate.prefix) &&
            name.length > candidate.prefix.length
        ) {
            return {
                server: candidate.server,
                tool: name.slice(candidate.prefix.length),
            };
        }
    }
    return undefined;
}

function sanitize(value: string): string {
    return value.replaceAll(/[^a-zA-Z0-9_-]/gu, '_');
}

/**
 * One file change for each file an OpenCode `apply_patch` changed, from the
 * per-file diffs in its metadata. A deleted file is reported as an edit, like
 * any other change to existing content.
 */
export function openCodePatchedFiles(
    details: ToolDetails,
    metadata: Record<string, unknown> | undefined
): Record<string, unknown>[] {
    const files = Array.isArray(metadata?.files) ? metadata.files : [];
    return files.flatMap((entry) => {
        const file = record(entry);
        const path = string(file?.movePath) ?? string(file?.filePath);
        if (!file || !path) return [];
        details.forget(path);
        const diff = string(file.patch) ?? string(file.diff);
        return [
            {
                path,
                operation: file.type === 'add' ? 'write' : 'edit',
                ...(diff ? details.unified(path, diff) : {}),
            },
        ];
    });
}
