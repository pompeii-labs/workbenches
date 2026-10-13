import { readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { resolveWindowsCommand } from '../runners/windows.js';

/** Resolve native commands and standard npm shims without interpreting arguments as batch source. */
export function hostCommand(
    command: string[],
    environment: Record<string, string | undefined>
): string[] {
    if (process.platform !== 'win32' || !command[0]) return command;
    return resolveWindowsCommand(command, (native) =>
        nativeHostCommand(native, environment)
    );
}

function nativeHostCommand(
    command: string[],
    environment: Record<string, string | undefined>
): string[] {
    if (!command[0]) return command;
    const path = environment.PATH ?? environment.Path ?? process.env.PATH ?? '';
    const executable = Bun.which(command[0], { PATH: path });
    if (!executable) return command;
    if (/\.cmd$/i.test(executable)) {
        const npm = npmCommand(executable, path);
        if (npm) return [...npm, ...command.slice(1)];
    }
    return [executable, ...command.slice(1)];
}

/** Only the unmodified npm cmd-shim template has equivalent direct-launch semantics. */
function npmCommand(shim: string, path: string): string[] | undefined {
    try {
        const details = statSync(shim);
        if (!details.isFile() || details.size > 64 * 1024) return undefined;
        const text = readFileSync(shim, 'utf8').trim();
        const template =
            /^@ECHO off\s+GOTO start\s+:find_dp0\s+SET dp0=%~dp0\s+EXIT \/b\s+:start\s+SETLOCAL\s+CALL :find_dp0\s+IF EXIST "%dp0%\\(node|bun)\.exe" \(\s+SET "_prog=%dp0%\\\1\.exe"\s+\) ELSE \(\s+SET "_prog=\1"\s+\)\s+endLocal & goto #_undefined_# 2>NUL \|\| title %COMSPEC% & (?:set PATHEXT=%PATHEXT:;\.JS;=;% & )?"%_prog%" "%dp0%\\([^"\r\n%]+)" %\*$/i;
        const match = text.match(template);
        if (!match?.[1] || !match[2]) return undefined;
        const local = join(dirname(shim), `${match[1]}.exe`);
        const interpreter = statSync(local, { throwIfNoEntry: false })?.isFile()
            ? local
            : Bun.which(`${match[1]}.exe`, { PATH: path });
        const script = resolve(dirname(shim), match[2]);
        return interpreter && statSync(script, { throwIfNoEntry: false })?.isFile()
            ? [interpreter, script]
            : undefined;
    } catch {
        return undefined;
    }
}

/** Stop a Windows runner and any subprocesses holding its input or output pipes. */
export function stopWindowsTree(pid: number): void {
    const taskkill = join(
        process.env.SystemRoot ?? 'C:\\Windows',
        'System32',
        'taskkill.exe'
    );
    Bun.spawnSync([taskkill, '/PID', String(pid), '/T', '/F'], {
        stdout: 'ignore',
        stderr: 'ignore',
        windowsHide: true,
    });
}
