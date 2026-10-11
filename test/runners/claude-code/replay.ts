import { deepStrictEqual } from 'node:assert';
import { readFileSync, writeFileSync } from 'node:fs';

/**
 * A fake `claude -p` for the trace replay tests. It replays a sanitized
 * recorded session from `REPLAY_FIXTURE` and checks what the adapter writes:
 * every input line's exact shape, each permission or question reply against the
 * recorded one, and that steering arrives only while a tool call is in flight.
 * It writes what it saw to `REPLAY_REPORT` when its input closes or it is
 * terminated.
 *
 * Output lines are replayed in order. A recorded user message waits until a
 * later output line names it, so the adapter may send it whenever it chooses; a
 * `queued` notice for a message the adapter has not sent yet is postponed until
 * it arrives. Interrupts and control replies are awaited where they were
 * recorded. Recorded ids of the adapter's own messages are replaced with the ids
 * it actually sent.
 */

type Line = Record<string, unknown>;
type Step = { dir: 'in' | 'out' | 'exit'; data: Line };
type Kind = 'user' | 'control_request' | 'control_response';

const steps = readFileSync(required('REPLAY_FIXTURE'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Step);
const argv = process.argv.slice(2);
const sessionId =
    argv[
        argv.findIndex((value) => value === '--session-id' || value === '--resume') + 1
    ];
const recordedSession = steps
    .map((step) => step.data.session_id)
    .find((value): value is string => typeof value === 'string' && value.length > 0);

const violations: string[] = [];
const ids = new Map<string, string>();
const pendingUsers: Line[] = [];
const postponed = new Map<string, Line[]>();
const buffer: Array<{ kind: Kind; line: Line }> = [];
const waiters: Array<() => void> = [];
/** The adapter's messages Claude Code has not completed or cancelled yet. */
const openCommands = new Set<string>();
const toolsInFlight = new Set<string>();
let position = 0;
let inputClosed = false;
let reported = false;

readInput();
process.on('SIGTERM', () => {
    report();
    process.exit(143);
});
await replay();
await closed();
report();

async function replay(): Promise<void> {
    for (; position < steps.length; position += 1) {
        const step = steps[position] as Step;
        if (step.dir === 'exit') return;
        if (step.dir === 'in') {
            if (!(await receive(step.data))) return;
            continue;
        }
        const text = JSON.stringify(step.data);
        const named = pendingUsers.filter((user) => text.includes(String(user.uuid)));
        if (named.length > 0) {
            const command = step.data.command_uuid;
            if (
                step.data.type === 'command_lifecycle' &&
                step.data.state === 'queued' &&
                !buffer.some((entry) => entry.kind === 'user')
            ) {
                const waiting = postponed.get(String(command)) ?? [];
                waiting.push(step.data);
                postponed.set(String(command), waiting);
                continue;
            }
            while (pendingUsers.some((user) => text.includes(String(user.uuid)))) {
                if (!(await mapNextUser())) return;
            }
        }
        emit(step.data);
    }
}

/** Takes the adapter's line for a recorded control step. User messages wait. */
async function receive(recorded: Line): Promise<boolean> {
    const type = String(recorded.type);
    if (type === 'user') {
        pendingUsers.push(recorded);
        return true;
    }
    const line = await take(type as Kind);
    if (!line) return false;
    if (type === 'control_request') {
        ids.set(String(recorded.request_id), String(line.request_id));
        const request = (recorded.request ?? {}) as Line;
        if ((line.request as Line).subtype !== request.subtype) {
            violations.push(`expected a ${String(request.subtype)} control request`);
        }
        return true;
    }
    const expected = recorded.response as Line;
    const actual = line.response as Line;
    if (actual.request_id !== expected.request_id) {
        violations.push(
            `reply to ${String(actual.request_id)}, expected ${String(expected.request_id)}`
        );
    }
    const want = expected.response as Line;
    const got = (actual.response ?? {}) as Line;
    if (got.behavior !== want.behavior) {
        violations.push(
            `reply ${String(got.behavior)}, expected ${String(want.behavior)}`
        );
    } else if (want.behavior === 'allow') {
        try {
            deepStrictEqual(got.updatedInput, want.updatedInput);
        } catch {
            violations.push(`updatedInput differs for ${String(expected.request_id)}`);
        }
    }
    return true;
}

async function mapNextUser(): Promise<boolean> {
    const recorded = pendingUsers.shift() as Line;
    const line = await take('user');
    if (!line) {
        pendingUsers.unshift(recorded);
        return false;
    }
    const want = (recorded.message as Line).content;
    const got = (line.message as Line).content;
    if (JSON.stringify(want) !== JSON.stringify(got)) {
        violations.push(
            `user message ${JSON.stringify(got)} expected ${JSON.stringify(want)}`
        );
    }
    ids.set(String(recorded.uuid), String(line.uuid));
    for (const queued of postponed.get(String(recorded.uuid)) ?? []) emit(queued);
    postponed.delete(String(recorded.uuid));
    return true;
}

function emit(recorded: Line): void {
    let text = JSON.stringify(recorded);
    for (const [from, to] of ids) text = text.replaceAll(from, to);
    if (recordedSession && sessionId)
        text = text.replaceAll(recordedSession, sessionId);
    const line = JSON.parse(text) as Line;
    track(line);
    process.stdout.write(`${text}\n`);
}

/** Follows the replayed turn so steering can be checked against it. */
function track(line: Line): void {
    if (
        line.type === 'command_lifecycle' &&
        (line.state === 'completed' || line.state === 'cancelled')
    ) {
        openCommands.delete(String(line.command_uuid));
    }
    if (line.type === 'result') toolsInFlight.clear();
    if (line.parent_tool_use_id) return;
    const content = (line.message as Line | undefined)?.content;
    if (!Array.isArray(content)) return;
    for (const block of content as Line[]) {
        if (line.type === 'assistant' && block.type === 'tool_use') {
            toolsInFlight.add(String(block.id));
        }
        if (line.type === 'user' && block.type === 'tool_result') {
            toolsInFlight.delete(String(block.tool_use_id));
        }
    }
}

function readInput(): void {
    let pending = '';
    process.stdin.on('data', (chunk) => {
        pending += chunk.toString();
        const lines = pending.split('\n');
        pending = lines.pop() ?? '';
        for (const line of lines) if (line.trim()) accept(line);
    });
    process.stdin.on('end', () => {
        if (pending.trim()) accept(pending);
        inputClosed = true;
        wake();
    });
}

function accept(text: string): void {
    let line: Line;
    try {
        line = JSON.parse(text) as Line;
    } catch {
        violations.push(`input is not JSON: ${text.slice(0, 80)}`);
        return;
    }
    const kind = checkShape(line);
    if (!kind) return;
    if (kind === 'user') {
        // A message sent while an earlier one is still open is steering.
        if (openCommands.size > 0 && toolsInFlight.size === 0) {
            violations.push('steering was written while no tool call was in flight');
        }
        openCommands.add(String(line.uuid));
    }
    buffer.push({ kind, line });
    wake();
}

function checkShape(line: Line): Kind | undefined {
    const keys = Object.keys(line).toSorted().join(',');
    if (line.type === 'user') {
        const message = line.message as Line;
        if (
            keys !== 'message,parent_tool_use_id,session_id,type,uuid' ||
            line.session_id !== '' ||
            line.parent_tool_use_id !== null ||
            typeof line.uuid !== 'string' ||
            Object.keys(message).toSorted().join(',') !== 'content,role' ||
            message.role !== 'user'
        ) {
            violations.push(`malformed user message: ${JSON.stringify(line)}`);
        }
        return 'user';
    }
    if (line.type === 'control_request') {
        if (
            keys !== 'request,request_id,type' ||
            JSON.stringify(line.request) !==
                '{"subtype":"interrupt","cancel_queued":true}'
        ) {
            violations.push(`malformed control request: ${JSON.stringify(line)}`);
        }
        return 'control_request';
    }
    if (line.type === 'control_response') {
        const response = line.response as Line;
        const inner = (response.response ?? {}) as Line;
        const innerKeys = Object.keys(inner).toSorted().join(',');
        if (
            keys !== 'response,type' ||
            Object.keys(response).toSorted().join(',') !==
                'request_id,response,subtype' ||
            response.subtype !== 'success' ||
            !(
                (inner.behavior === 'allow' && innerKeys === 'behavior,updatedInput') ||
                (inner.behavior === 'deny' &&
                    innerKeys === 'behavior,message' &&
                    typeof inner.message === 'string')
            )
        ) {
            violations.push(`malformed control response: ${JSON.stringify(line)}`);
        }
        return 'control_response';
    }
    violations.push(`unexpected input type ${String(line.type)}`);
    return undefined;
}

async function take(kind: Kind): Promise<Line | undefined> {
    for (;;) {
        const index = buffer.findIndex((entry) => entry.kind === kind);
        if (index >= 0) return buffer.splice(index, 1)[0]?.line;
        if (inputClosed) return undefined;
        await new Promise<void>((resolve) => waiters.push(resolve));
    }
}

async function closed(): Promise<void> {
    while (!inputClosed) await new Promise<void>((resolve) => waiters.push(resolve));
}

function wake(): void {
    for (const resolve of waiters.splice(0)) resolve();
}

function report(): void {
    if (reported) return;
    reported = true;
    const remaining =
        pendingUsers.length +
        steps.slice(position).filter((step) => step.dir === 'in').length;
    writeFileSync(
        required('REPLAY_REPORT'),
        JSON.stringify({
            argv,
            cwd: process.cwd(),
            environment: Object.fromEntries(
                Object.entries(process.env).filter(
                    ([name]) =>
                        name.startsWith('CLAUDE') || name.startsWith('ANTHROPIC')
                )
            ),
            violations,
            remainingInputs: remaining,
            leftovers: buffer.map((entry) => entry.line),
        })
    );
}

function required(name: string): string {
    const value = process.env[name];
    if (!value) throw new Error(`${name} is required`);
    return value;
}
