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

/** Quote one argument for Windows CreateProcess, not for a command shell. */
function nativeArgument(value: string): string {
    if (value.length > 0 && !/[\s"]/.test(value)) return value;
    return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
}

const wrappers = new WeakMap<
    string[],
    {
        command: string[];
        setup: string[];
        successExitCodes: readonly number[] | undefined;
    }
>();

/** Encode scripts so command arguments and paths are never interpreted as shell source. */
export function windowsInvocation(
    invocation: RunnerInvocation,
    setup: string,
    input?: string,
    successExitCodes?: readonly number[]
): RunnerInvocation {
    const previous = wrappers.get(invocation.command);
    const native = previous?.command ?? invocation.command;
    const steps = [setup, ...(previous?.setup ?? [])].filter(Boolean);
    const accepted = successExitCodes ?? previous?.successExitCodes;
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
    // PowerShell's native pipeline can lose or buffer redirected handles on
    // headless Windows hosts. Start the child without a console and bridge its
    // byte streams explicitly, including RPC input that remains open.
    const script = [
        "$ErrorActionPreference = 'Stop'",
        "$ProgressPreference = 'SilentlyContinue'",
        '$OutputEncoding = [Console]::OutputEncoding = New-Object Text.UTF8Encoding $false',
        ...steps,
        ...(/\.(?:cmd|bat)$/i.test(resolved[0] ?? '')
            ? [
                  launch,
                  ...(accepted?.length
                      ? [
                            `if (@(${accepted.join(', ')}) -contains $LASTEXITCODE) { exit 0 }`,
                        ]
                      : []),
                  'exit $LASTEXITCODE',
              ]
            : [
                  `$workbenchCommand = @(${command.join(', ')})`,
                  '$start = [Diagnostics.ProcessStartInfo]::new()',
                  '$start.FileName = $workbenchCommand[0]',
                  `$start.Arguments = ${powershellQuote(resolved.slice(1).map(nativeArgument).join(' '))}`,
                  '$start.UseShellExecute = $false',
                  '$start.CreateNoWindow = $true',
                  '$start.RedirectStandardInput = $true',
                  '$start.RedirectStandardOutput = $true',
                  '$start.RedirectStandardError = $true',
                  '$child = [Diagnostics.Process]::Start($start)',
                  '$outputCopy = $child.StandardOutput.BaseStream.CopyToAsync([Console]::OpenStandardOutput())',
                  '$errorCopy = $child.StandardError.BaseStream.CopyToAsync([Console]::OpenStandardError())',
                  // Process.StandardInput normally buffers short RPC messages.
                  '$inputPipe = [IO.FileStream]::new($child.StandardInput.BaseStream.SafeFileHandle, [IO.FileAccess]::Write, 1, $false)',
                  '$inputCopy = [Console]::OpenStandardInput().CopyToAsync($inputPipe)',
                  '$inputClosed = $false',
                  'while (!$child.WaitForExit(20)) {',
                  '  if (!$inputClosed -and $inputCopy.IsCompleted) { $inputPipe.Close(); $inputClosed = $true }',
                  '}',
                  '[Threading.Tasks.Task]::WaitAll(@($outputCopy, $errorCopy))',
                  ...(accepted?.length
                      ? [
                            `if (@(${accepted.join(', ')}) -contains $child.ExitCode) { exit 0 }`,
                        ]
                      : []),
                  'exit $child.ExitCode',
              ]),
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
    wrappers.set(wrapped.command, {
        command: native,
        setup: steps,
        successExitCodes: accepted,
    });
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
        undefined,
        wrapper.successExitCodes
    ).command;
}
