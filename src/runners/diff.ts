/** A unified diff of one file and the lines it adds and removes. */
export interface FilePatch {
    patch: string;
    additions: number;
    deletions: number;
}

/** One hunk as a runner reports it, with its lines prefixed by ` `, `-`, or `+`. */
export interface PatchHunk {
    oldStart: number;
    oldLines: number;
    newStart: number;
    newLines: number;
    lines: readonly string[];
}

const CONTEXT = 3;
/** Beyond this many edits, the changed middle of a file is shown as replaced whole. */
const MAXIMUM_EDITS = 1000;
const NO_NEWLINE = '\\ No newline at end of file';

type Operation = { kind: ' ' | '-' | '+'; line: string };

/** The headers every patch carries, for `path` relative to the workspace. */
export function patchHeader(path: string): string {
    return `--- a/${path}\n+++ b/${path}\n`;
}

/** The unified diff that turns `before` into `after`. */
export function unifiedDiff(path: string, before: string, after: string): FilePatch {
    const operations = diffLines(lines(before), lines(after));
    let additions = 0;
    let deletions = 0;
    for (const operation of operations) {
        if (operation.kind === '+') additions++;
        if (operation.kind === '-') deletions++;
    }
    return {
        patch: patchHeader(path) + hunks(operations).join(''),
        additions,
        deletions,
    };
}

/** A patch from hunks a runner reported, such as Claude Code's structured patch. */
export function patchFromHunks(path: string, hunks: readonly PatchHunk[]): FilePatch {
    const body = hunks
        .map(
            (hunk) =>
                `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@\n${hunk.lines.map((line) => `${line}\n`).join('')}`
        )
        .join('');
    return { patch: patchHeader(path) + body, ...counts(body) };
}

/**
 * A runner's or Git's own unified diff with its file headers replaced by the
 * standard ones for `path`, or undefined when it has no hunk, as for a binary
 * file.
 */
export function patchFromUnified(path: string, diff: string): FilePatch | undefined {
    const start = diff.startsWith('@@') ? 0 : diff.indexOf('\n@@');
    if (start < 0) return undefined;
    let body = diff.slice(start === 0 ? 0 : start + 1);
    if (!body.endsWith('\n')) body += '\n';
    return { patch: patchHeader(path) + body, ...counts(body) };
}

function counts(body: string): { additions: number; deletions: number } {
    let additions = 0;
    let deletions = 0;
    for (const line of body.split('\n')) {
        if (line.startsWith('+')) additions++;
        else if (line.startsWith('-')) deletions++;
    }
    return { additions, deletions };
}

/**
 * The lines of a text, each with its line ending, so a last line without one
 * differs from the same line with one.
 */
function lines(text: string): string[] {
    if (!text) return [];
    const parts = text.split('\n');
    const last = parts.pop() ?? '';
    const result = parts.map((part) => `${part}\n`);
    if (last) result.push(last);
    return result;
}

function diffLines(before: string[], after: string[]): Operation[] {
    let prefix = 0;
    while (
        prefix < before.length &&
        prefix < after.length &&
        before[prefix] === after[prefix]
    ) {
        prefix++;
    }
    let suffix = 0;
    while (
        suffix < before.length - prefix &&
        suffix < after.length - prefix &&
        before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
    ) {
        suffix++;
    }
    const oldMiddle = before.slice(prefix, before.length - suffix);
    const newMiddle = after.slice(prefix, after.length - suffix);
    const middle = myers(oldMiddle, newMiddle) ?? [
        ...oldMiddle.map((line) => ({ kind: '-' as const, line })),
        ...newMiddle.map((line) => ({ kind: '+' as const, line })),
    ];
    return [
        ...before.slice(0, prefix).map((line) => ({ kind: ' ' as const, line })),
        ...middle,
        ...before
            .slice(before.length - suffix)
            .map((line) => ({ kind: ' ' as const, line })),
    ];
}

/** The shortest edit script, or undefined when it needs too many edits. */
function myers(before: string[], after: string[]): Operation[] | undefined {
    const n = before.length;
    const m = after.length;
    const trace: Int32Array[] = [];
    let previous = new Int32Array(1);
    const at = (row: Int32Array, d: number, k: number) =>
        k < -d || k > d ? -1 : (row[k + d] ?? -1);
    for (let d = 0; d <= Math.min(n + m, MAXIMUM_EDITS); d++) {
        const current = new Int32Array(2 * d + 1);
        for (let k = -d; k <= d; k += 2) {
            let x: number;
            if (d === 0) x = 0;
            else if (
                k === -d ||
                (k !== d && at(previous, d - 1, k - 1) < at(previous, d - 1, k + 1))
            ) {
                x = at(previous, d - 1, k + 1);
            } else {
                x = at(previous, d - 1, k - 1) + 1;
            }
            let y = x - k;
            while (x < n && y < m && before[x] === after[y]) {
                x++;
                y++;
            }
            current[k + d] = x;
            if (x >= n && y >= m) {
                trace.push(current);
                return backtrack(trace, before, after, at);
            }
        }
        trace.push(current);
        previous = current;
    }
    return undefined;
}

function backtrack(
    trace: Int32Array[],
    before: string[],
    after: string[],
    at: (row: Int32Array, d: number, k: number) => number
): Operation[] {
    const operations: Operation[] = [];
    let x = before.length;
    let y = after.length;
    for (let d = trace.length - 1; d > 0; d--) {
        const previous = trace[d - 1] ?? new Int32Array(0);
        const k = x - y;
        const down =
            k === -d ||
            (k !== d && at(previous, d - 1, k - 1) < at(previous, d - 1, k + 1));
        const previousK = down ? k + 1 : k - 1;
        const previousX = at(previous, d - 1, previousK);
        const previousY = previousX - previousK;
        while (x > previousX && y > previousY) {
            operations.push({ kind: ' ', line: before[--x] ?? '' });
            y--;
        }
        if (down) operations.push({ kind: '+', line: after[--y] ?? '' });
        else operations.push({ kind: '-', line: before[--x] ?? '' });
    }
    while (x > 0 && y > 0) {
        operations.push({ kind: ' ', line: before[--x] ?? '' });
        y--;
    }
    return operations.reverse();
}

/** The operations grouped into hunks with three lines of context. */
function hunks(operations: Operation[]): string[] {
    const changed = operations.flatMap((operation, index) =>
        operation.kind === ' ' ? [] : [index]
    );
    const result: string[] = [];
    let index = 0;
    while (index < changed.length) {
        const first = changed[index] ?? 0;
        let last = first;
        while (
            index + 1 < changed.length &&
            (changed[index + 1] ?? 0) - last <= 2 * CONTEXT + 1
        ) {
            last = changed[++index] ?? last;
        }
        index++;
        const start = Math.max(0, first - CONTEXT);
        const end = Math.min(operations.length, last + CONTEXT + 1);
        result.push(hunk(operations, start, end));
    }
    return result;
}

function hunk(operations: Operation[], start: number, end: number): string {
    let oldLine = 1;
    let newLine = 1;
    for (const operation of operations.slice(0, start)) {
        if (operation.kind !== '+') oldLine++;
        if (operation.kind !== '-') newLine++;
    }
    let oldCount = 0;
    let newCount = 0;
    let body = '';
    for (const operation of operations.slice(start, end)) {
        if (operation.kind !== '+') oldCount++;
        if (operation.kind !== '-') newCount++;
        const text = operation.line.endsWith('\n')
            ? operation.line
            : `${operation.line}\n${NO_NEWLINE}\n`;
        body += operation.kind + text;
    }
    const oldStart = oldCount === 0 ? oldLine - 1 : oldLine;
    const newStart = newCount === 0 ? newLine - 1 : newLine;
    return `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@\n${body}`;
}

/** The patch with every hunk moved `offset` lines, for a diff of an excerpt of a file. */
export function shiftPatch(change: FilePatch, offset: number): FilePatch {
    if (offset === 0) return change;
    const shift = (start: string) => String(Math.max(0, Number(start) + offset));
    return {
        ...change,
        patch: change.patch.replaceAll(
            /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@/gmu,
            (
                _match,
                oldStart: string,
                oldLines: string,
                newStart: string,
                newLines: string
            ) => `@@ -${shift(oldStart)},${oldLines} +${shift(newStart)},${newLines} @@`
        ),
    };
}

/** How many whole lines two texts share at their start. */
export function commonLeadingLines(before: string, after: string): number {
    const left = before.split('\n');
    const right = after.split('\n');
    let count = 0;
    // The last piece of each is a partial line, so it never counts as shared.
    while (
        count < left.length - 1 &&
        count < right.length - 1 &&
        left[count] === right[count]
    ) {
        count++;
    }
    return count;
}
