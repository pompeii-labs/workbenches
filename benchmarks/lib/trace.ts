import {
    closeSync,
    existsSync,
    openSync,
    readdirSync,
    readFileSync,
    unlinkSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;

export interface NativeExportTarget {
    sessionId: string;
    database?: string;
}

/** Keep tool diagnostics only, never prompts, reasoning, provider config or attachments. */
export function diagnosticTools(value: any): unknown {
    const scrub = (item: any): any => {
        if (typeof item === 'string')
            return item
                .replace(/\bsk-[A-Za-z0-9_-]+/g, '[REDACTED]')
                .replace(/\bBearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [REDACTED]')
                .replace(/\bBasic\s+[A-Za-z0-9+/_=-]+/gi, 'Basic [REDACTED]')
                .replace(
                    /\b([a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:)[^@/\s]+@/gi,
                    '$1[REDACTED]@'
                )
                .replace(
                    /\b([A-Z0-9_]*(?:API_KEY|ANON_KEY|TOKEN|PASSWORD|SECRET)[A-Z0-9_]*)\s*=\s*[^\s;]+/gi,
                    '$1=[REDACTED]'
                );
        if (Array.isArray(item)) return item.map(scrub);
        if (item && typeof item === 'object')
            return Object.fromEntries(
                Object.entries(item).flatMap(([key, entry]) => {
                    // Tool records can nest runner context. It is diagnostic scope only.
                    if (
                        /^(?:prompt|reasoning|attachments?|provider(?:config)?|messages?)$/i.test(
                            key
                        )
                    )
                        return [];
                    return [
                        [
                            key,
                            /(?:^|[_-])(?:authorization|cookie|password|secret|token|api[_-]?key|anon[_-]?key)$/i.test(
                                key
                            )
                                ? '[REDACTED]'
                                : scrub(entry),
                        ],
                    ];
                })
            );
        return item;
    };
    if (!value || !Array.isArray(value.messages))
        throw new Error('Native export has no messages');
    return {
        version: 1,
        kind: 'tool-diagnostics',
        tools: value.messages.flatMap((message: any) =>
            (message.parts ?? [])
                .filter((part: any) => part.type === 'tool')
                .map((part: any) =>
                    scrub({
                        id: part.callID ?? part.id,
                        name: part.tool,
                        status: part.state?.status,
                        input: part.state?.input,
                        output: part.state?.output,
                        error: part.state?.error,
                    })
                )
        ),
    };
}

function requireSessionId(value: unknown, source: string): string {
    if (typeof value !== 'string' || !SESSION_ID.test(value))
        throw new Error(`Invalid native session id in ${source}`);
    return value;
}

/**
 * Select the one OpenCode session owned by a fresh Workbench actor home.
 * Do not guess across multiple sessions: a trace must be attributable to one run.
 */
export function discoverWorkbenchExport(home: string): NativeExportTarget {
    const sessions = join(resolve(home), '.workbench', 'sessions');
    if (!existsSync(sessions))
        throw new Error(`Missing Workbench sessions: ${sessions}`);
    const matches: NativeExportTarget[] = [];
    for (const entry of readdirSync(sessions, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const directory = join(sessions, entry.name);
        const metadata = join(directory, 'session.json');
        if (!existsSync(metadata))
            throw new Error(`Missing session metadata: ${metadata}`);
        let parsed: unknown;
        try {
            parsed = JSON.parse(readFileSync(metadata, 'utf8'));
        } catch {
            throw new Error(`Malformed session metadata: ${metadata}`);
        }
        if (!parsed || typeof parsed !== 'object')
            throw new Error(`Malformed session metadata: ${metadata}`);
        const sessionId = requireSessionId(
            (parsed as Record<string, unknown>).native_session_id,
            metadata
        );
        const database = join(directory, 'native', 'opencode.sqlite');
        if (!existsSync(database))
            throw new Error(`Missing native database: ${database}`);
        matches.push({ sessionId, database });
    }
    if (matches.length !== 1)
        throw new Error(
            `Expected exactly one native Workbench session, found ${matches.length}`
        );
    return matches[0]!;
}

export function selectNativeExport(
    home: string,
    arm: string,
    plainSessionId?: string
): NativeExportTarget {
    if (arm === 'workbench') {
        if (plainSessionId !== undefined)
            throw new Error('Workbench export must not receive a plain session id');
        return discoverWorkbenchExport(home);
    }
    if (arm === 'plain') {
        if (plainSessionId === undefined)
            throw new Error('Plain export requires its saved native session id');
        return { sessionId: requireSessionId(plainSessionId, 'plain argument') };
    }
    throw new Error(`Unknown export arm: ${arm}`);
}

export async function exportNativeTrace(
    home: string,
    arm: string,
    plainSessionId?: string
): Promise<string> {
    const target = selectNativeExport(home, arm, plainSessionId);
    // Some CLI versions exit before a large stdout pipe has drained. A regular
    // file descriptor avoids truncation. Docker's private /dev/shm is tmpfs;
    // never put an unsanitized export in the mounted workspace. The /tmp
    // fallback supports local, synthetic regression tests on macOS.
    const temporary = `${existsSync('/dev/shm') ? '/dev/shm' : '/tmp'}/workbenchmark-native-export-${crypto.randomUUID()}.json`;
    const descriptor = openSync(temporary, 'wx', 0o600);
    try {
        const child = Bun.spawn(['opencode', 'export', target.sessionId, '--pure'], {
            env: {
                HOME: resolve(home),
                PATH: process.env.PATH,
                OPENCODE_DISABLE_MODELS_FETCH: 'true',
                ...(target.database ? { OPENCODE_DB: target.database } : {}),
            },
            stdout: descriptor,
            stderr: 'pipe',
        });
        const [stderr, code] = await Promise.all([
            new Response(child.stderr).text(),
            child.exited,
        ]);
        const stdout = readFileSync(temporary, 'utf8');
        if (code !== 0)
            throw new Error(
                `OpenCode export failed (${code}): ${stderr.trim().slice(-400)}`
            );
        let parsed: unknown;
        try {
            parsed = JSON.parse(stdout);
        } catch {
            throw new Error(
                `OpenCode export did not return JSON (${JSON.stringify({
                    bytes: Buffer.byteLength(stdout),
                    starts_object: stdout.trimStart().startsWith('{'),
                    ends_object: stdout.trimEnd().endsWith('}'),
                    ansi: stdout.includes('\u001b['),
                })})`
            );
        }
        return JSON.stringify(diagnosticTools(parsed)) + '\n';
    } finally {
        closeSync(descriptor);
        unlinkSync(temporary);
    }
}

if (import.meta.main) {
    const [home, arm, plainSessionId, ...extra] = Bun.argv.slice(2);
    if (!home || !arm || extra.length > 0) {
        console.error('Usage: trace.ts <home> <plain|workbench> [plain-session-id]');
        process.exitCode = 2;
    } else {
        exportNativeTrace(home, arm, plainSessionId)
            .then((trace) => process.stdout.write(trace))
            .catch((error: unknown) => {
                console.error(error instanceof Error ? error.message : String(error));
                process.exitCode = 1;
            });
    }
}
