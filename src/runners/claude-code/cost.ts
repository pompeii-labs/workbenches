import type { PreparedRuntime } from '../../runtimes/contracts.js';
import { isWindowsPath, windowsInvocation } from '../windows.js';

/** Where a session keeps the last cumulative native cost between processes. */
export interface ClaudeCodeCostStore {
    /** The recorded total, or undefined when none is recorded. */
    read(): Promise<number | undefined>;
    write(total: number): Promise<void>;
}

/** How a route is paid: per token, or by a Claude subscription. */
export type ClaudeCodeBilling = 'metered' | 'subscription';

/**
 * Turns Claude Code's cumulative `total_cost_usd` into per-turn costs. The total
 * spans the whole native session, earlier processes included, so the last total
 * is recorded in the session's store and a resumed process starts from it. A
 * subscription route reports no spend, but its totals are still recorded so a
 * later metered process starts from the right baseline.
 */
export class ClaudeCodeCost {
    private reported: number;
    private writing: Promise<void> = Promise.resolve();

    private constructor(
        private readonly billing: ClaudeCodeBilling,
        baseline: number,
        private readonly store: ClaudeCodeCostStore | undefined
    ) {
        this.reported = baseline;
    }

    /** A cost for a new native session that nothing persists. */
    static fresh(billing: ClaudeCodeBilling = 'metered'): ClaudeCodeCost {
        return new ClaudeCodeCost(billing, 0, undefined);
    }

    /** A cost that starts from the store's recorded total and records each new one. */
    static async open(
        billing: ClaudeCodeBilling,
        store: ClaudeCodeCostStore
    ): Promise<ClaudeCodeCost> {
        const recorded = await store.read().catch(() => undefined);
        return new ClaudeCodeCost(billing, recorded ?? 0, store);
    }

    /** The cost of the native turn that reported the cumulative `total`. */
    delta(total: number | undefined): number | undefined {
        if (total !== undefined && total >= 0) {
            // A lower total means Claude Code restarted its count.
            const delta = total >= this.reported ? total - this.reported : total;
            this.reported = total;
            this.record(total);
            if (this.billing === 'metered') return delta;
        }
        return this.billing === 'subscription' ? 0 : undefined;
    }

    /** Resolves once every recorded total is written. */
    flush(): Promise<void> {
        return this.writing;
    }

    private record(total: number): void {
        const store = this.store;
        if (!store) return;
        // Cost bookkeeping never fails a turn. A lost write only shifts the next
        // resumed baseline.
        this.writing = this.writing.then(() => store.write(total)).catch(() => {});
    }
}

/** Where the cost file lives: the runtime that runs the session. */
export type ClaudeCodeCostRuntime = Pick<
    PreparedRuntime,
    'execute' | 'workspaceDirectory' | 'environment'
>;

/**
 * Records the cumulative cost in a file through the runtime's own commands, so
 * it lands in the session state wherever the session runs. Only `PATH` reaches
 * the command.
 */
export function runtimeCostStore(
    runtime: ClaudeCodeCostRuntime,
    path: string
): ClaudeCodeCostStore {
    if (isWindowsPath(runtime.workspaceDirectory)) {
        const run = (setup: string, value?: string) =>
            runtime.execute(
                windowsInvocation(
                    {
                        command: [
                            process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe',
                            '/d',
                            '/c',
                            'exit',
                            '0',
                        ],
                        cwd: runtime.workspaceDirectory,
                        env: {
                            PATH: runtime.environment.PATH,
                            SystemRoot: process.env.SystemRoot,
                            WORKBENCH_COST_PATH: path,
                            WORKBENCH_COST_VALUE: value,
                        },
                    },
                    setup
                ),
                { network: 'none' }
            );
        return {
            read: async () =>
                parseRecordedCost(
                    (
                        await run(
                            'if (Test-Path -LiteralPath $env:WORKBENCH_COST_PATH) { [Console]::Out.Write([IO.File]::ReadAllText($env:WORKBENCH_COST_PATH)) }'
                        )
                    ).stdout
                ),
            write: async (total) => {
                const result = await run(
                    '[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($env:WORKBENCH_COST_PATH)) | Out-Null; [IO.File]::WriteAllText($env:WORKBENCH_COST_PATH + ".tmp", ($env:WORKBENCH_COST_VALUE + "`n"), (New-Object Text.UTF8Encoding $false)); Move-Item -LiteralPath ($env:WORKBENCH_COST_PATH + ".tmp") -Destination $env:WORKBENCH_COST_PATH -Force',
                    formatRecordedCost(total)
                );
                if (result.code !== 0)
                    throw new Error('Claude Code cost was not recorded');
            },
        };
    }
    const run = (script: string, ...values: string[]) =>
        runtime.execute(
            {
                command: ['/bin/sh', '-c', script, 'workbench-cost', path, ...values],
                cwd: runtime.workspaceDirectory,
                env: runtime.environment.PATH ? { PATH: runtime.environment.PATH } : {},
            },
            { network: 'none' }
        );
    return {
        read: async () =>
            parseRecordedCost((await run('cat "$1" 2>/dev/null || true')).stdout),
        write: async (total) => {
            const result = await run(
                'mkdir -p "$(dirname "$1")" && printf "%s\\n" "$2" > "$1.tmp" && mv -f "$1.tmp" "$1"',
                formatRecordedCost(total)
            );
            if (result.code !== 0) throw new Error('Claude Code cost was not recorded');
        },
    };
}

/** Parses a recorded total, or undefined for anything else. */
export function parseRecordedCost(text: string): number | undefined {
    try {
        const value = (JSON.parse(text) as { total_cost_usd?: unknown })
            ?.total_cost_usd;
        return typeof value === 'number' && Number.isFinite(value) && value >= 0
            ? value
            : undefined;
    } catch {
        return undefined;
    }
}

export function formatRecordedCost(total: number): string {
    return JSON.stringify({ total_cost_usd: total });
}
