import type { ResolvedWorkbench, RunnerInvocation } from '../../types.js';
import { isWindowsPath, windowsInvocation } from '../windows.js';
import { runtimeContext } from './runtime.js';

/** The staged context files a runner reads at launch. */
export class RunnerContext {
    constructor(
        readonly prefix: string,
        readonly instructions: string
    ) {}

    /** The same files at the paths a runtime sees them under. */
    remap(pathFor: (path: string) => string): RunnerContext {
        return new RunnerContext(pathFor(this.prefix), pathFor(this.instructions));
    }

    /** Wraps `invocation` so the runner starts with the context file written. */
    apply(
        invocation: RunnerInvocation,
        workbench: ResolvedWorkbench
    ): RunnerInvocation {
        if (isWindowsPath(invocation.cwd)) {
            const context = runtimeContext(
                workbench,
                invocation.cwd,
                invocation.env
            ).replaceAll('\n', ' ');
            return windowsInvocation(
                {
                    ...invocation,
                    env: {
                        ...invocation.env,
                        WORKBENCH_CONTEXT_PREFIX: this.prefix,
                        WORKBENCH_CONTEXT_FILE: this.instructions,
                        WORKBENCH_RUNTIME_CONTEXT: context,
                    },
                },
                '[IO.File]::WriteAllText($env:WORKBENCH_CONTEXT_FILE, [IO.File]::ReadAllText($env:WORKBENCH_CONTEXT_PREFIX) + "`n" + $env:WORKBENCH_RUNTIME_CONTEXT + "`n", (New-Object Text.UTF8Encoding $false))'
            );
        }
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
                WORKBENCH_CONTEXT_PREFIX: this.prefix,
                WORKBENCH_CONTEXT_FILE: this.instructions,
                WORKBENCH_RUNTIME_CONTEXT: runtimeContext(
                    workbench,
                    invocation.cwd,
                    invocation.env
                ).replaceAll('\n', ' '),
            },
        };
    }
}
