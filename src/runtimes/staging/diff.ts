/**
 * Renders git-style unified diffs in plain TypeScript, so a host with no `git`
 * binary can still return a reviewable patch. The output follows `git diff`
 * closely enough to read and to apply with `git apply`, but it omits `index`
 * lines and cannot encode binary changes: a binary change is reported as
 * "Binary files a/x and b/x differ".
 */

export interface DiffSide {
    mode: number;
    /** File bytes, or the link target for a symlink. */
    content: Uint8Array;
    symlink?: boolean;
    /** The content could not be read, so the change is reported without a patch. */
    unavailable?: boolean;
}

const context = 3;
/** Past this many edits the diff replaces the file, which bounds memory. */
const maximumEditDistance = 1_500;

export function renderDiff(
    path: string,
    before: DiffSide | undefined,
    after: DiffSide | undefined
): string {
    const header = [`diff --git a/${path} b/${path}`];
    const a = before ? `a/${path}` : '/dev/null';
    const b = after ? `b/${path}` : '/dev/null';
    if (!before && after) header.push(`new file mode ${gitMode(after)}`);
    else if (before && !after) header.push(`deleted file mode ${gitMode(before)}`);
    else if (before && after && gitMode(before) !== gitMode(after)) {
        header.push(`old mode ${gitMode(before)}`, `new mode ${gitMode(after)}`);
    }
    if (
        before &&
        after &&
        !before.unavailable &&
        !after.unavailable &&
        sameBytes(before.content, after.content)
    ) {
        return header.length > 1 ? `${header.join('\n')}\n` : '';
    }
    if (isBinary(before) || isBinary(after)) {
        return `${header.join('\n')}\nBinary files ${a} and ${b} differ\n`;
    }
    const left = before ? lines(before.content) : [];
    const right = after ? lines(after.content) : [];
    const hunks = render(left, right);
    return [...header, `--- ${a}`, `+++ ${b}`, ...hunks].join('\n').concat('\n');
}

function gitMode(side: DiffSide): string {
    if (side.symlink) return '120000';
    return side.mode & 0o111 ? '100755' : '100644';
}

function isBinary(side: DiffSide | undefined): boolean {
    return (
        side !== undefined &&
        (side.unavailable === true ||
            (!side.symlink && side.content.subarray(0, 8_192).includes(0)))
    );
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
    if (left.byteLength !== right.byteLength) return false;
    for (let index = 0; index < left.byteLength; index++) {
        if (left[index] !== right[index]) return false;
    }
    return true;
}

interface Line {
    text: string;
    /** False for a final line with no trailing newline. */
    terminated: boolean;
}

function lines(content: Uint8Array): Line[] {
    if (content.byteLength === 0) return [];
    const source = new TextDecoder().decode(content);
    const parts = source.split('\n');
    const result: Line[] = [];
    for (const [index, text] of parts.entries()) {
        if (index === parts.length - 1) {
            if (text !== '') result.push({ text, terminated: false });
        } else {
            result.push({ text, terminated: true });
        }
    }
    return result;
}

type Operation = { kind: ' ' | '-' | '+'; line: Line };

function render(left: Line[], right: Line[]): string[] {
    const operations = edit(left, right);
    const output: string[] = [];
    let index = 0;
    while (index < operations.length) {
        while (index < operations.length && operations[index]?.kind === ' ') index++;
        if (index >= operations.length) break;
        const start = Math.max(0, index - context);
        let end = index;
        let quiet = 0;
        while (end < operations.length) {
            if (operations[end]?.kind === ' ') {
                // Changes closer than twice the context share one hunk.
                if (quiet === context * 2) break;
                quiet++;
            } else {
                quiet = 0;
            }
            end++;
        }
        const last = Math.min(operations.length, end - Math.max(0, quiet - context));
        const slice = operations.slice(start, last);
        const leftBefore = operations
            .slice(0, start)
            .filter((op) => op.kind !== '+').length;
        const rightBefore = operations
            .slice(0, start)
            .filter((op) => op.kind !== '-').length;
        const leftCount = slice.filter((op) => op.kind !== '+').length;
        const rightCount = slice.filter((op) => op.kind !== '-').length;
        const leftStart = leftCount === 0 ? leftBefore : leftBefore + 1;
        const rightStart = rightCount === 0 ? rightBefore : rightBefore + 1;
        output.push(
            `@@ -${range(leftStart, leftCount)} +${range(rightStart, rightCount)} @@${functionContext(left, leftBefore)}`
        );
        for (const operation of slice) {
            output.push(`${operation.kind}${operation.line.text}`);
            if (!operation.line.terminated) output.push('\\ No newline at end of file');
        }
        index = last;
    }
    return output;
}

/** Git's default hunk label: the nearest earlier line that starts like a declaration. */
function functionContext(left: Line[], before: number): string {
    for (let index = before - 1; index >= 0; index--) {
        const text = left[index]?.text ?? '';
        if (/^[A-Za-z_$]/.test(text)) return ` ${text.slice(0, 80).trimEnd()}`;
    }
    return '';
}

function range(start: number, count: number): string {
    return count === 1 ? `${start}` : `${start},${count}`;
}

function sameLine(left: Line, right: Line): boolean {
    return left.text === right.text && left.terminated === right.terminated;
}

/** Myers' shortest edit script. Falls back to replacing everything when the files differ too much. */
function edit(left: Line[], right: Line[]): Operation[] {
    let prefix = 0;
    while (
        prefix < left.length &&
        prefix < right.length &&
        sameLine(left[prefix] as Line, right[prefix] as Line)
    ) {
        prefix++;
    }
    let suffix = 0;
    while (
        suffix < left.length - prefix &&
        suffix < right.length - prefix &&
        sameLine(
            left[left.length - 1 - suffix] as Line,
            right[right.length - 1 - suffix] as Line
        )
    ) {
        suffix++;
    }
    const a = left.slice(prefix, left.length - suffix);
    const b = right.slice(prefix, right.length - suffix);
    const middle = shortest(a, b);
    return [
        ...left.slice(0, prefix).map((line): Operation => ({ kind: ' ', line })),
        ...middle,
        ...left
            .slice(left.length - suffix)
            .map((line): Operation => ({ kind: ' ', line })),
    ];
}

function shortest(a: Line[], b: Line[]): Operation[] {
    const n = a.length;
    const m = b.length;
    if (n === 0) return b.map((line): Operation => ({ kind: '+', line }));
    if (m === 0) return a.map((line): Operation => ({ kind: '-', line }));
    const max = Math.min(n + m, maximumEditDistance);
    const offset = max;
    const frontier = new Int32Array(2 * max + 2);
    const trace: Int32Array[] = [];
    let found = -1;
    for (let distance = 0; distance <= max && found < 0; distance++) {
        trace.push(frontier.slice());
        for (let k = -distance; k <= distance; k += 2) {
            let x: number;
            if (
                k === -distance ||
                (k !== distance &&
                    (frontier[offset + k - 1] ?? 0) < (frontier[offset + k + 1] ?? 0))
            ) {
                x = frontier[offset + k + 1] ?? 0;
            } else {
                x = (frontier[offset + k - 1] ?? 0) + 1;
            }
            let y = x - k;
            while (x < n && y < m && sameLine(a[x] as Line, b[y] as Line)) {
                x++;
                y++;
            }
            frontier[offset + k] = x;
            if (x >= n && y >= m) {
                found = distance;
                break;
            }
        }
    }
    if (found < 0) {
        return [
            ...a.map((line): Operation => ({ kind: '-', line })),
            ...b.map((line): Operation => ({ kind: '+', line })),
        ];
    }
    const reversed: Operation[] = [];
    let x = n;
    let y = m;
    for (let distance = found; distance > 0; distance--) {
        const previous = trace[distance] as Int32Array;
        const k = x - y;
        const down =
            k === -distance ||
            (k !== distance &&
                (previous[offset + k - 1] ?? 0) < (previous[offset + k + 1] ?? 0));
        const previousK = down ? k + 1 : k - 1;
        const previousX = previous[offset + previousK] ?? 0;
        const previousY = previousX - previousK;
        while (x > previousX && y > previousY) {
            reversed.push({ kind: ' ', line: a[x - 1] as Line });
            x--;
            y--;
        }
        if (down) reversed.push({ kind: '+', line: b[y - 1] as Line });
        else reversed.push({ kind: '-', line: a[x - 1] as Line });
        x = previousX;
        y = previousY;
    }
    while (x > 0 && y > 0) {
        reversed.push({ kind: ' ', line: a[x - 1] as Line });
        x--;
        y--;
    }
    return reversed.reverse();
}
