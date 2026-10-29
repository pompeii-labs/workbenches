import { stripVTControlCharacters } from 'node:util';
import type { ResolvedWorkbench } from '../types.js';
import { boundInput, boundOutput, boundPatch } from './bounds.js';
import {
    commonLeadingLines,
    type FilePatch,
    type PatchHunk,
    patchFromHunks,
    patchFromUnified,
    shiftPatch,
    unifiedDiff,
} from './diff.js';
import { REDACTED, redactCredentials } from './redaction.js';
import { injectedSecrets, uniqueSecrets } from './secrets.js';
import { scrubSecretText, scrubShellText } from './shell.js';

/** The tool shapes whose `command` argument is a shell command line. */
const SHELL_TOOLS = new Set(['bash', 'shell', 'shell_command']);

/**
 * Argument names whose values are credentials, compared without case or
 * separators: `api_key`, `apiKey`, and `API-KEY` all match.
 */
const SECRET_KEY =
    /token|secret|password|passwd|apikey|authorization|credential|privatekey|accesskey|cookie/u;

export interface ToolDetailsOptions {
    /** Exact values to redact wherever they appear. */
    secrets?: Iterable<string>;
    /** The workspace root as the runner sees it; patch paths are relative to it. */
    workspace?: string;
}

/**
 * The tool arguments, results, and file changes a run reports, scrubbed and
 * bounded before they enter an event. It owns the exact credential values to
 * redact, the workspace that patch paths are relative to, and the contents of
 * files the run wrote, so a later write to the same path can be shown as a diff.
 */
export class ToolDetails {
    readonly workspace: string | undefined;
    private readonly secrets: string[];
    private readonly contents = new Map<string, string>();

    constructor(options: ToolDetailsOptions = {}) {
        this.secrets = uniqueSecrets(options.secrets ?? []);
        this.workspace = options.workspace?.replace(/\/+$/u, '') || undefined;
    }

    /** Details for a session: its Workbench's declared and credential values, and its workspace. */
    static forSession(
        options: {
            workbench: Pick<ResolvedWorkbench, 'manifest'>;
            environment: Record<string, string | undefined>;
            workspaceDirectory: string;
        },
        secrets: Iterable<string> = []
    ): ToolDetails {
        return new ToolDetails({
            secrets: [
                ...injectedSecrets(
                    options.environment,
                    Object.keys(options.workbench.manifest.env)
                ),
                ...secrets,
            ],
            workspace: options.workspaceDirectory,
        });
    }

    /** `input` and `input_truncated` for a tool call's arguments, or nothing without them. */
    input(
        name: string,
        input: Record<string, unknown> | undefined
    ): { input?: Record<string, unknown>; input_truncated?: true } {
        if (!input) return {};
        const shell = SHELL_TOOLS.has(name.trim().toLowerCase());
        const scrubbed = this.scrubValue(input, shell);
        const value =
            scrubbed !== null &&
            typeof scrubbed === 'object' &&
            !Array.isArray(scrubbed)
                ? Object.fromEntries(Object.entries(scrubbed))
                : {};
        const bounded = boundInput(value);
        return {
            input: bounded.input,
            ...(bounded.truncated ? { input_truncated: true as const } : {}),
        };
    }

    /** `output` and `output_truncated` for a tool's result text, or nothing without it. */
    output(text: string | undefined): { output?: string; output_truncated?: true } {
        if (text === undefined) return {};
        const bounded = boundOutput(this.scrubText(plainText(text)));
        return {
            output: bounded.text,
            ...(bounded.truncated ? { output_truncated: true as const } : {}),
        };
    }

    /**
     * `patch`, `additions`, and `deletions` for one file's change, or nothing
     * for a binary file. Credential values and recognizable key formats are
     * redacted from the patch.
     */
    patch(change: FilePatch | undefined): {
        patch?: string;
        additions?: number;
        deletions?: number;
        patch_truncated?: true;
    } {
        if (!change || change.patch.includes('\u0000')) return {};
        const bounded = boundPatch(redactCredentials(this.redactExact(change.patch)));
        return {
            patch: bounded.patch,
            additions: change.additions,
            deletions: change.deletions,
            ...(bounded.truncated ? { patch_truncated: true as const } : {}),
        };
    }

    /**
     * Applies this instance's redaction again to details another instance
     * built, such as an adapter that knew fewer credential values.
     */
    refine(data: Record<string, unknown>): Record<string, unknown> {
        const result = { ...data };
        const input = data.input;
        if (input !== null && typeof input === 'object' && !Array.isArray(input)) {
            const name = typeof data.name === 'string' ? data.name : '';
            const refined = this.input(name, Object.fromEntries(Object.entries(input)));
            result.input = refined.input;
            if (refined.input_truncated) result.input_truncated = true;
        }
        if (typeof data.output === 'string') {
            const refined = this.output(data.output);
            result.output = refined.output;
            if (refined.output_truncated) result.output_truncated = true;
        }
        if (typeof data.patch === 'string') {
            const bounded = boundPatch(redactCredentials(this.redactExact(data.patch)));
            result.patch = bounded.patch;
            if (bounded.truncated) result.patch_truncated = true;
        }
        return result;
    }

    /** `path` relative to the workspace, as patch headers name it. */
    relative(path: string): string {
        const workspace = this.workspace;
        if (workspace && path.startsWith(`${workspace}/`)) {
            return path.slice(workspace.length + 1);
        }
        return path.replace(/^\/+/u, '');
    }

    /** The patch fields for a change from `before` to `after` at `path`. */
    diff(
        path: string,
        before: string,
        after: string
    ): ReturnType<ToolDetails['patch']> {
        return this.patch(unifiedDiff(this.relative(path), before, after));
    }

    /** The patch fields for a runner's own unified diff of `path`. */
    unified(path: string, diff: string): ReturnType<ToolDetails['patch']> {
        return this.patch(patchFromUnified(this.relative(path), diff));
    }

    /** The patch fields for hunks a runner reported for `path`. */
    hunks(path: string, hunks: readonly PatchHunk[]): ReturnType<ToolDetails['patch']> {
        return this.patch(patchFromHunks(this.relative(path), hunks));
    }

    /**
     * The patch fields for one replacement whose file is unknown: a diff of
     * the replaced text alone, placed at `firstChangedLine` of the new file
     * when the runner reports it.
     */
    excerpt(
        path: string,
        oldText: string,
        newText: string,
        firstChangedLine?: number
    ): ReturnType<ToolDetails['patch']> {
        const before = oldText.endsWith('\n') ? oldText : `${oldText}\n`;
        const after = newText.endsWith('\n') ? newText : `${newText}\n`;
        const change = unifiedDiff(this.relative(path), before, after);
        const offset =
            firstChangedLine !== undefined && Number.isInteger(firstChangedLine)
                ? firstChangedLine - 1 - commonLeadingLines(before, after)
                : 0;
        return this.patch(shiftPatch(change, offset));
    }

    /**
     * Records a whole-file write and returns its patch fields: against the
     * contents the run last wrote, against `previous` when the runner reported
     * them, or nothing when neither is known.
     */
    written(
        path: string,
        contents: string,
        previous?: string
    ): ReturnType<ToolDetails['patch']> {
        const before = previous ?? this.contents.get(path);
        this.contents.set(path, contents);
        return before === undefined ? {} : this.diff(path, before, contents);
    }

    /**
     * Applies text replacements to the contents the run last wrote to `path`,
     * returning the file before and after, or undefined when the contents are
     * unknown or a replaced text is not in them.
     */
    edited(
        path: string,
        edits: readonly { oldText: string; newText: string; replaceAll?: boolean }[]
    ): { before: string; after: string } | undefined {
        const before = this.contents.get(path);
        if (before === undefined) return undefined;
        let after = before;
        for (const edit of edits) {
            if (!edit.oldText || !after.includes(edit.oldText)) {
                this.contents.delete(path);
                return undefined;
            }
            after = edit.replaceAll
                ? after.replaceAll(edit.oldText, edit.newText)
                : after.replace(edit.oldText, () => edit.newText);
        }
        this.contents.set(path, after);
        return { before, after };
    }

    /** Records the whole contents of `path` after a change the runner described in full. */
    remember(path: string, contents: string): void {
        this.contents.set(path, contents);
    }

    /** Forgets `path` after a change whose result is unknown. */
    forget(path: string): void {
        this.contents.delete(path);
    }

    private scrubValue(value: unknown, shell: boolean, key?: string): unknown {
        if (key !== undefined && isSecretKey(key)) return REDACTED;
        if (typeof value === 'string') {
            return shell && key === 'command'
                ? scrubShellText(this.redactExact(value))
                : this.scrubText(value);
        }
        if (Array.isArray(value)) {
            return value.map((item) => this.scrubValue(item, shell));
        }
        if (value !== null && typeof value === 'object') {
            return Object.fromEntries(
                Object.entries(value).map(([name, item]) => [
                    name,
                    this.scrubValue(item, shell, name),
                ])
            );
        }
        return value;
    }

    private scrubText(text: string): string {
        return scrubSecretText(this.redactExact(text));
    }

    private redactExact(text: string): string {
        let result = text;
        for (const secret of this.secrets) result = result.replaceAll(secret, REDACTED);
        return result;
    }
}

function isSecretKey(name: string): boolean {
    return SECRET_KEY.test(name.toLowerCase().replaceAll(/[^a-z0-9]/gu, ''));
}

/** Text without terminal escapes or control characters other than tabs and line breaks. */
function plainText(text: string): string {
    return Array.from(stripVTControlCharacters(text.replaceAll('\r\n', '\n')))
        .filter((character) => {
            const code = character.charCodeAt(0);
            return (
                code === 9 ||
                code === 10 ||
                (code >= 32 && !(code >= 127 && code <= 159))
            );
        })
        .join('');
}

/**
 * The text of a result that may be a string or a list of parts. Text parts
 * contribute their text; images and other parts contribute nothing.
 */
export function resultText(value: unknown): string | undefined {
    if (typeof value === 'string') return value;
    if (!Array.isArray(value)) return undefined;
    const texts = value.flatMap((part) => {
        if (part === null || typeof part !== 'object' || Array.isArray(part)) return [];
        const type = Reflect.get(part, 'type');
        const text = Reflect.get(part, 'text');
        return type === 'text' && typeof text === 'string' ? [text] : [];
    });
    return texts.length > 0 ? texts.join('\n') : undefined;
}
