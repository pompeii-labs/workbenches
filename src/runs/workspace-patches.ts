import { posix } from 'node:path';
import type { PreparedRuntime } from '../runtimes/contracts.js';

/** How long the host waits for Git before reporting a change without a patch. */
const TIMEOUT_MS = 10_000;

/**
 * The diff of one path against the workspace's committed version, or of the
 * whole file when Git does not track it. Git, not the engine, reads the file,
 * inside the runtime where the runner wrote it. Nothing is printed outside a
 * Git work tree.
 */
const SCRIPT = [
    'cd "$1" 2>/dev/null || exit 0',
    'g() { git --no-optional-locks -c core.quotepath=off -c safe.directory="*" "$@"; }',
    'g rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0',
    'if g ls-files --error-unmatch -- "$2" >/dev/null 2>&1; then',
    '  g diff --no-color --no-ext-diff --no-textconv HEAD -- "$2"',
    'else',
    '  g diff --no-color --no-ext-diff --no-textconv --no-index -- /dev/null "$2"',
    'fi',
    'exit 0',
].join('\n');

/**
 * Computes a file change's patch from the workspace when the runner's own
 * data could not: the path's diff against the committed version through the
 * runtime's own Git, so it works the same on every runtime whose image or
 * sandbox has Git. Outside a Git work tree, or without Git, a change has no
 * patch.
 */
export class WorkspacePatches {
    constructor(
        private readonly runtime: Pick<
            PreparedRuntime,
            'execute' | 'workspaceDirectory' | 'environment'
        >,
        private readonly timeoutMs = TIMEOUT_MS
    ) {}

    /** The workspace root as the runner sees it. */
    get workspace(): string {
        return this.runtime.workspaceDirectory;
    }

    /** The path relative to the workspace, or undefined outside it. */
    relative(path: string): string | undefined {
        const root = this.runtime.workspaceDirectory;
        const absolute = posix.isAbsolute(path) ? path : posix.join(root, path);
        const relative = posix.relative(root, posix.normalize(absolute));
        return relative && !relative.startsWith('..') && !posix.isAbsolute(relative)
            ? relative
            : undefined;
    }

    /** Git's diff of `path` against the committed version, or undefined. */
    async diff(path: string): Promise<string | undefined> {
        const relative = this.relative(path);
        if (!relative) return undefined;
        const root = this.runtime.workspaceDirectory;
        const result = this.runtime
            .execute(
                {
                    command: [
                        '/bin/sh',
                        '-c',
                        SCRIPT,
                        'workbench-patch',
                        root,
                        relative,
                    ],
                    cwd: root,
                    env: this.runtime.environment.PATH
                        ? { PATH: this.runtime.environment.PATH }
                        : {},
                },
                { network: 'none', readOnly: true }
            )
            .then(
                (output) =>
                    output.code === 0 && output.stdout ? output.stdout : undefined,
                () => undefined
            );
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<undefined>((resolve) => {
            timer = setTimeout(() => resolve(undefined), this.timeoutMs);
        });
        try {
            return await Promise.race([result, timeout]);
        } finally {
            clearTimeout(timer);
        }
    }
}
