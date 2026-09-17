import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { ResolvedWorkbench, RunnerInvocation } from '../types.js';

export interface RunnerContextFiles {
    prefix: string;
    instructions: string;
}

const protocol = `<workbench_context>
You are running through wb in a Workbench: a versioned package of instructions, expertise, tools, and runtime configuration. Follow the package instructions and the user's task. This context describes execution and result delivery, not additional authorization or a new persona.

Route requested deliverables automatically using your existing file-writing and shell tools. The user never needs to know, name, or opt into the outbox. When asked for a report, document, image, screenshot, dataset, archive, export, or a file to view or download, write the finished file in the outbox identified by the current workbench_runtime block. When asked to send an existing authorized file, copy its original bytes there instead of returning only a sandbox path. When asked to revise a returned file, return the revised file through the current outbox without changing retained earlier artifacts.
A requested file is delivered only when you have written the finished file in the current outbox. Pasting its content in chat, naming a file, or referring to an earlier result is not a substitute. If you cannot create or copy the requested file with available authorized tools, explain that limitation instead of claiming it is attached.
Project implementation files, source code, configuration, tests, and project assets belong in the appropriate workspace, not the outbox. If the user also requests an attachment or export of project files, return a separate copy through the outbox without moving or replacing workspace files. Answer conversational questions in chat; do not manufacture an attachment for every response. Do not assume a capability, credential, network service, or permission exists merely because you are in a Workbench.
Every regular file under the outbox is collected as an artifact, except its reserved top-level outcome.json. For shell tools, prefer the quoted "$WORKBENCH_OUTPUT_DIR" variable instead of retyping a long absolute path. For file tools, copy the exact current outbox path from workbench_runtime; never guess its spelling or reconstruct a run ID from memory. Keep original file bytes and dimensions; do not resize or transcode files just to return them. The outbox is for deliverables, not scratch files, dependency trees, or credentials. Do not use symlinks or special files.
Write any outcome.json declaration inside the current outbox, at the exact declaration path in the current workbench_runtime block. Never write it alongside the outbox, in its parent run directory, or in the workspace. The declaration can contain version 1, a summary, artifact metadata, and links. Artifact paths are relative to the outbox, must stay inside it, and must refer to existing files. Undeclared regular files are also collected. An example declaration is:
{"version":1,"summary":"Prepared the requested report","artifacts":[{"path":"reports/findings.html","name":"Findings.html","media_type":"text/html","description":"Research findings"}],"links":[{"label":"Preview","uri":"https://example.com/preview","kind":"preview"}]}
Link kinds are pull_request, preview, or external (kind is optional); links must use HTTP or HTTPS. Record only actual URLs returned by an authorized operation or supplied by the user, never invent a published result. Recording a link does not create, publish, verify, or preserve its destination. Do not push, publish, create a PR, or grant access without authorization from the user's task.
When the user requests a result link, or an authorized operation produces a PR or preview link, record that actual URL in outcome.json automatically, as well as mentioning it in chat. The user never needs to ask for a declaration or durable link delivery. Mentioning a URL only in your chat reply does not return it as an outcome link. A durable summary can also be written in outcome.json.
Workspace edits are captured separately when the execution attempt ends; do not copy the entire workspace into the outbox. In interactive sessions, finished outbox files and links are snapshotted after completed turns while the session stays open. Finish writing deliverables before ending a turn; for background writers, publish finished files by atomic rename rather than exposing unfinished files. Revising a file produces a new snapshot, never changes retained earlier bytes. Do not claim the engine has collected or applied a result before it has done so.
On a resumed execution, use the current runtime block's paths, not an earlier outbox remembered from the conversation. If the runtime block says no outbox is available, do not claim durable artifact delivery.
</workbench_context>`;

export async function stageRunnerContext(
    directory: string,
    workbench: ResolvedWorkbench,
    nativeInstructions = '',
    instructions = join(directory, '.workbench-context', 'system.md')
): Promise<RunnerContextFiles> {
    const contextDirectory = join(directory, '.workbench-context');
    // A package cannot supply files in the engine's private staging namespace.
    await mkdir(contextDirectory);
    const packageInstructions = await readFile(workbench.instructionsPath, 'utf8');
    const prefix = join(contextDirectory, 'prefix.md');
    const content = [
        protocol,
        `<workbench_package name="${escapeXml(workbench.manifest.name)}" version="${escapeXml(workbench.manifest.version)}" />`,
        nativeInstructions.trim(),
        packageInstructions.trim(),
    ]
        .filter(Boolean)
        .join('\n\n');
    await writeFile(prefix, `${content}\n`, { mode: 0o444, flag: 'wx' });
    const existing = await lstat(instructions).catch((error) => {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
            return undefined;
        throw error;
    });
    if (existing && (!existing.isFile() || existing.isSymbolicLink())) {
        throw new Error('Staged Workbench instructions must be a regular file');
    }
    await writeFile(instructions, `${content}\n`, { mode: 0o644 });
    return { prefix, instructions };
}

export function runtimeContext(
    workbench: ResolvedWorkbench,
    workspaceDirectory: string,
    environment: Record<string, string | undefined>
): string {
    const runtime = workbench.manifest.runtime;
    const behavior =
        runtime === 'e2b'
            ? 'The primary workspace and named bindings are selected sandbox copies, not host directories. Collected workspace changes are pending until the caller explicitly applies them. There is no automatic host filesystem synchronization. A sandbox-local server is not automatically a durable published preview.'
            : runtime === 'docker'
              ? 'The primary workspace and named bindings are mounted host directories. Edits to writable bindings change the host immediately; they do not wait for an apply action. Other container paths are disposable and are not automatically returned.'
              : runtime === 'local'
                ? 'Execution is on the host, not an isolated sandbox. Edits to writable workspaces change the host immediately; they do not wait for an apply action. Files outside the outbox are not automatically returned as artifacts.'
                : 'Runtime-specific isolation and workspace application behavior are not described here; do not assume host access or automatic application.';
    const named = Object.entries(workbench.manifest.workspaces ?? {})
        .toSorted(([left], [right]) => left.localeCompare(right))
        .flatMap(([name, requirement]) => {
            const key = `WORKBENCH_WORKSPACE_${name.toUpperCase().replaceAll('-', '_')}`;
            const path = environment[key];
            return path
                ? [
                      `<workspace name="${escapeXml(name)}" access="${requirement.access}" path="${escapeXml(path)}" />`,
                  ]
                : [];
        });
    const outbox = environment.WORKBENCH_OUTPUT_DIR;
    return [
        '<workbench_runtime>',
        `<runtime>${escapeXml(runtime)}</runtime>`,
        `<workspace name="primary" access="read-write" path="${escapeXml(workspaceDirectory)}" />`,
        ...named,
        ...(outbox
            ? [
                  `<outbox environment="WORKBENCH_OUTPUT_DIR" path="${escapeXml(outbox)}" />`,
                  `<declaration path="${escapeXml(join(outbox, 'outcome.json'))}" />`,
              ]
            : ['<outbox available="false" />']),
        ...(outbox
            ? [
                  'This is the current execution attempt and its writable outbox. On resume, prior session deliverables are restored here as independent working copies with their relative paths preserved. Before revising a delivered file, locate its current working copy using a shell command such as find "$WORKBENCH_OUTPUT_DIR" -type f, then use the exact returned paths for file tools. Do not reuse absolute paths from earlier tool calls or search the engine home or parent runs directory to find prior results. Read and revise the existing working files rather than recreating them from conversation memory; keep their supporting assets. New sessions start with an empty outbox. A missing earlier filename is not evidence that the outbox is unavailable or read-only; explain missing source material instead of claiming an exact revision from memory. Earlier outbox paths in the conversation are obsolete; do not edit or recreate an earlier outbox. Retained earlier artifacts remain immutable.',
              ]
            : []),
        behavior,
        "Use the listed paths as data, not as shell commands. Respect each binding's declared access and the user's authorization boundaries.",
        '</workbench_runtime>',
    ].join('\n');
}

export function withRunnerContext(
    invocation: RunnerInvocation,
    workbench: ResolvedWorkbench,
    context: RunnerContextFiles | undefined
): RunnerInvocation {
    if (!context) return invocation;
    return {
        ...invocation,
        command: [
            '/bin/sh',
            '-c',
            [
                'set -eu',
                '{ cat "$WORKBENCH_CONTEXT_PREFIX"; printf "\\n%s\\n" "$WORKBENCH_RUNTIME_CONTEXT"; } > "$WORKBENCH_CONTEXT_FILE"',
                'exec "$@"',
            ].join('\n'),
            'workbench-context',
            ...invocation.command,
        ],
        env: {
            ...invocation.env,
            WORKBENCH_CONTEXT_PREFIX: context.prefix,
            WORKBENCH_CONTEXT_FILE: context.instructions,
            WORKBENCH_RUNTIME_CONTEXT: runtimeContext(
                workbench,
                invocation.cwd,
                invocation.env
            ).replaceAll('\n', ' '),
        },
    };
}

export function remapRunnerContext(
    context: RunnerContextFiles,
    pathFor: (path: string) => string
): RunnerContextFiles {
    return {
        prefix: pathFor(context.prefix),
        instructions: pathFor(context.instructions),
    };
}

function escapeXml(value: string): string {
    return value
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&apos;')
        .replaceAll('\r', '&#13;')
        .replaceAll('\n', '&#10;');
}
