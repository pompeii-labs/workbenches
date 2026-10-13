import { hostEnvironment } from '../../platform/environment.js';
import type { RunnerInvocation } from '../../types.js';
import { isWindowsPath, powershellQuote, windowsInvocation } from '../windows.js';

/** The files a session's staged configuration provides. */
export interface ClaudeCodeStagedPaths {
    /** The per-session `CLAUDE_CONFIG_DIR`, which `--setting-sources user` reads. */
    configDirectory: string;
    mcpConfigPath: string;
    /** The instructions appended to Claude Code's system prompt. */
    systemPromptPath: string;
}

export interface ClaudeCodeInvocationOptions {
    workspaceDirectory: string;
    /** The inherited environment. Its `CLAUDE*` and `ANTHROPIC_*` variables are dropped. */
    environment: Record<string, string | undefined>;
    /** The credential and route variables the selected connection needs. */
    routeEnvironment: Record<string, string>;
    /** The native model id. */
    model: string;
    paths: ClaudeCodeStagedPaths;
    /** The `--settings` value: a settings file or its JSON text. */
    settings: string;
    /** Directories outside the workspace the tools may reach: the outbox and named workspaces. */
    additionalDirectories?: string[] | undefined;
    /** The host answers prompts. Otherwise anything that would prompt is denied. */
    answersPrompts: boolean;
    /** The native session to create, or with `resume`, to reopen. */
    session: { id: string; resume: boolean };
    maxTurns?: number | undefined;
    /** The credential store directory. Empty uses the person's normal Claude Code login. */
    secureStorageDirectory: string;
    /** Claude Code strips credentials from its subprocesses. It needs bubblewrap on Linux. */
    scrubSubprocessEnvironment: boolean;
}

/** Builds the long-lived `claude` stream-json process for one execution. */
export function buildClaudeCodeInvocation(
    options: ClaudeCodeInvocationOptions
): RunnerInvocation {
    if (!options.model.trim()) throw new Error('Claude Code needs a model');
    if (!options.session.id.trim()) throw new Error('Claude Code needs a session id');
    if (
        options.maxTurns !== undefined &&
        (!Number.isSafeInteger(options.maxTurns) || options.maxTurns < 1)
    ) {
        throw new Error('Claude Code max turns must be a positive integer');
    }
    const command = [
        'claude',
        '-p',
        '--input-format',
        'stream-json',
        '--output-format',
        'stream-json',
        '--verbose',
        '--replay-user-messages',
        '--model',
        options.model,
        '--setting-sources',
        'user',
        '--settings',
        options.settings,
        '--strict-mcp-config',
        '--mcp-config',
        options.paths.mcpConfigPath,
        '--append-system-prompt-file',
        options.paths.systemPromptPath,
        // A resumed session renders the current prompt, with fresh runtime facts.
        '--system-prompt-snapshot',
        'off',
        ...(options.additionalDirectories ?? []).flatMap((directory) => [
            '--add-dir',
            directory,
        ]),
        ...(options.answersPrompts
            ? ['--permission-prompt-tool', 'stdio']
            : ['--permission-prompts', 'none']),
        ...(options.session.resume
            ? ['--resume', options.session.id]
            : ['--session-id', options.session.id]),
        ...(options.maxTurns === undefined
            ? []
            : ['--max-turns', String(options.maxTurns)]),
    ];
    return {
        command,
        cwd: options.workspaceDirectory,
        env: {
            ...withoutClaudeVariables(options.environment),
            PWD: options.workspaceDirectory,
            ...options.routeEnvironment,
            CLAUDE_CONFIG_DIR: options.paths.configDirectory,
            CLAUDE_SECURESTORAGE_CONFIG_DIR: options.secureStorageDirectory,
            CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
            CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: options.scrubSubprocessEnvironment
                ? '1'
                : '0',
        },
    };
}

/**
 * Inherited Claude Code and Anthropic settings, such as Bedrock, Vertex, a base
 * URL, or the parent's own `CLAUDECODE` marker, would reroute or reconfigure the
 * child. Only the selected route's variables reach it.
 */
function inheritedClaudeVariable(name: string): boolean {
    return name.startsWith('CLAUDE') || name.startsWith('ANTHROPIC_');
}

/** The environment without inherited Claude Code and Anthropic variables. */
export function withoutClaudeVariables(
    environment: Record<string, string | undefined>
): Record<string, string | undefined> {
    return Object.fromEntries(
        Object.entries(hostEnvironment(environment)).filter(
            ([name]) => !inheritedClaudeVariable(name)
        )
    );
}

/**
 * Copies `find` entries, parents first, into the directory in `$0`: a new
 * writable directory for each directory, and `cp -RP` for anything else, so a
 * link is copied as a link.
 */
const copyEntries =
    'set -e; for entry do if [ -d "$entry" ] && [ ! -L "$entry" ]; then mkdir "$0/$entry"; else cp -RP "$entry" "$0/$entry"; fi; done';

/**
 * What Claude Code 2.1.292 loads from `CLAUDE_CONFIG_DIR` as user-level
 * behavior: its custom item directories (`commands`, `agents`,
 * `output-styles`, `skills`, `workflows`, `routines`), instruction `rules`,
 * `hooks`, installed `plugins` and `cowork_plugins`, `themes`, and the
 * `settings.json` and `CLAUDE.md` files. A session's process may have written
 * any of them, so each launch removes them all. Transcripts under `projects`
 * and the cost file are native state and stay.
 */
const SESSION_CONFIG_ENTRIES = [
    'settings.json',
    'CLAUDE.md',
    'skills',
    'commands',
    'agents',
    'output-styles',
    'workflows',
    'routines',
    'rules',
    'hooks',
    'plugins',
    'cowork_plugins',
    'themes',
];

/**
 * Starts Claude Code in the session's persistent `CLAUDE_CONFIG_DIR`, which
 * keeps the native transcripts and cost state between processes. Each launch
 * removes every user-level entry an earlier process left, because settings
 * arrive with the launch, then copies in the staged skills. An entry swapped
 * for a link is removed without being followed.
 *
 * The copy makes every directory writable before filling it, never with the
 * staged read-only mode. `cp -R` creates a directory with its source mode and
 * then changes it, and Docker Desktop's file sharing refuses to change the
 * mode of a directory created without owner write.
 */
export function inSessionConfig(
    invocation: RunnerInvocation,
    skills: string
): RunnerInvocation {
    if (isWindowsPath(invocation.cwd)) {
        return windowsInvocation(
            {
                ...invocation,
                env: { ...invocation.env, WORKBENCH_CLAUDE_SKILLS: skills },
            },
            [
                '$config = $env:CLAUDE_CONFIG_DIR',
                'if ((Test-Path -LiteralPath $config) -and ((Get-Item -LiteralPath $config -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "CLAUDE_CONFIG_DIR is a symlink" }',
                '[IO.Directory]::CreateDirectory($config) | Out-Null',
                `foreach ($entry in @(${SESSION_CONFIG_ENTRIES.map(powershellQuote).join(',')})) {`,
                '  $path = Join-Path $config $entry',
                '  if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Recurse -Force }',
                '}',
                '$skills = Join-Path $config "skills"',
                '[IO.Directory]::CreateDirectory($skills) | Out-Null',
                'Get-ChildItem -LiteralPath $env:WORKBENCH_CLAUDE_SKILLS -Force | Copy-Item -Destination $skills -Recurse -Force',
            ].join('\n')
        );
    }
    return {
        ...invocation,
        command: [
            '/bin/sh',
            '-c',
            [
                'set -eu',
                'if [ -L "$CLAUDE_CONFIG_DIR" ]; then echo "workbench: CLAUDE_CONFIG_DIR is a symlink" >&2; exit 1; fi',
                'mkdir -p "$CLAUDE_CONFIG_DIR"',
                `for entry in ${SESSION_CONFIG_ENTRIES.join(' ')}; do`,
                '  path="$CLAUDE_CONFIG_DIR/$entry"',
                '  if [ -d "$path" ] && [ ! -L "$path" ]; then chmod -R u+w "$path"; rm -rf "$path"; else rm -f "$path"; fi',
                'done',
                'skills="$CLAUDE_CONFIG_DIR/skills"',
                'mkdir "$skills"',
                `(cd "$WORKBENCH_CLAUDE_SKILLS" && find . ! -name . -exec sh -c '${copyEntries}' "$skills" {} +)`,
                'exec "$@"',
            ].join('\n'),
            'workbench-claude',
            ...invocation.command,
        ],
        env: { ...invocation.env, WORKBENCH_CLAUDE_SKILLS: skills },
    };
}

/**
 * The most UTF-16 code units one argument of the input line holds: at most
 * 96 KiB of UTF-8, under the 128 KiB Linux allows any single argument or
 * environment value.
 */
const INPUT_CHUNK = 32_768;

/**
 * Feeds one stream-json line on standard input, as a session does, so the
 * process runs it and exits. The line reaches the launch script as a count and
 * that many bounded arguments, never an environment value, and the script
 * joins them into a here-document. The line is JSON, so it is one line that
 * can never end the here-document early.
 */
export function withInput(
    invocation: RunnerInvocation,
    line: string
): RunnerInvocation {
    if (isWindowsPath(invocation.cwd)) return windowsInvocation(invocation, '', line);
    const chunks = inputChunks(line);
    return {
        ...invocation,
        command: [
            '/bin/sh',
            '-c',
            [
                'count=$1',
                'shift',
                'input=',
                'while [ "$count" -gt 0 ]; do input=$input$1; shift; count=$((count - 1)); done',
                'exec "$@" <<WORKBENCH_INPUT',
                '$input',
                'WORKBENCH_INPUT',
            ].join('\n'),
            'workbench-claude',
            String(chunks.length),
            ...chunks,
            ...invocation.command,
        ],
    };
}

/** Splits `line` into arguments, never between the halves of a surrogate pair. */
function inputChunks(line: string): string[] {
    const chunks: string[] = [];
    for (let start = 0; start < line.length; ) {
        let end = Math.min(start + INPUT_CHUNK, line.length);
        const last = line.charCodeAt(end - 1);
        if (end < line.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
        chunks.push(line.slice(start, end));
        start = end;
    }
    return chunks;
}
