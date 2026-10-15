import { join } from 'node:path';
import { launchEnvironment } from '../platform/environment.js';
import type { RunnerInvocation } from '../types.js';

/** Runtime paths, rather than the host OS, decide which shell can execute a wrapper. */
export function isWindowsPath(path: string): boolean {
    return /^[a-z]:[\\/]/i.test(path) || path.startsWith('\\\\');
}

export function powershellQuote(value: string): string {
    return `'${value.replaceAll("'", "''")}'`;
}

const wrappers = new WeakMap<
    string[],
    { command: string[]; setup: string[]; input: boolean }
>();

/** Encode scripts so command arguments and paths are never interpreted as shell source. */
export function windowsInvocation(
    invocation: RunnerInvocation,
    setup: string,
    input?: string
): RunnerInvocation {
    const previous = wrappers.get(invocation.command);
    const native = previous?.command ?? invocation.command;
    const steps = [setup, ...(previous?.setup ?? [])].filter(Boolean);
    const hasInput = input !== undefined || previous?.input === true;
    const resolved = native;
    if (
        /\.(?:cmd|bat)$/i.test(resolved[0] ?? '') &&
        resolved.slice(1).some((part) => /[&|<>^()%!\r\n]/.test(part))
    )
        throw new Error(
            'Windows batch arguments require a native executable or an unmodified npm shim'
        );
    const command = resolved.map(powershellQuote);
    const launch = `& ${command.join(' ')}`;
    const script = [
        "$ErrorActionPreference = 'Stop'",
        "$ProgressPreference = 'SilentlyContinue'",
        '$OutputEncoding = [Console]::OutputEncoding = New-Object Text.UTF8Encoding $false',
        ...steps,
        !hasInput
            ? launch
            : `([IO.StreamReader]::new([Console]::OpenStandardInput(), [Text.Encoding]::UTF8)).ReadToEnd() | ${launch}`,
        'exit $LASTEXITCODE',
    ].join('\n');
    const wrapped: RunnerInvocation = {
        ...invocation,
        env: launchEnvironment(invocation.env),
        ...(input === undefined ? {} : { input }),
        command: [
            process.platform === 'win32'
                ? join(
                      process.env.SystemRoot ?? 'C:\\Windows',
                      'System32',
                      'WindowsPowerShell',
                      'v1.0',
                      'powershell.exe'
                  )
                : 'powershell.exe',
            '-NoLogo',
            '-NoProfile',
            '-NonInteractive',
            '-InputFormat',
            'None',
            '-EncodedCommand',
            Buffer.from(script, 'utf16le').toString('base64'),
        ],
    };
    wrappers.set(wrapped.command, { command: native, setup: steps, input: hasInput });
    return wrapped;
}

/** Resolve an engine-owned setup wrapper at the host launch boundary. */
export function resolveWindowsCommand(
    command: string[],
    resolveCommand: (command: string[]) => string[]
): string[] {
    const wrapper = wrappers.get(command);
    if (!wrapper) return resolveCommand(command);
    return windowsInvocation(
        { command: resolveCommand(wrapper.command), cwd: '', env: {} },
        wrapper.setup.join('\n'),
        wrapper.input ? '' : undefined
    ).command;
}
