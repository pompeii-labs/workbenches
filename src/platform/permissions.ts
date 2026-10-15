import * as sync from 'node:fs';
import * as fs from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

let currentSid: string | undefined;
function systemTool(name: string): string {
    return join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', name);
}
function sid(): string {
    if (currentSid) return currentSid;
    const result = Bun.spawnSync(
        [systemTool('whoami.exe'), '/user', '/fo', 'csv', '/nh'],
        { windowsHide: true }
    );
    const found = new TextDecoder().decode(result.stdout).match(/S-1-[0-9-]+/);
    if (result.exitCode !== 0 || !found)
        throw new Error('Cannot identify the Windows account for private storage');
    currentSid = found[0];
    return currentSid;
}

/** Restrict an engine-owned path to its current account on Windows. */
function protect(path: string, directory: boolean): void {
    const grant = `*${sid()}:${directory ? '(OI)(CI)' : ''}F`;
    // Reset explicit grants before removing inherited grants. Private storage
    // must not retain a broad allow rule from a pre-existing engine file.
    for (const args of [['/reset'], ['/grant:r', grant, '/inheritance:r']]) {
        const result = Bun.spawnSync([systemTool('icacls.exe'), path, ...args], {
            stdout: 'ignore',
            stderr: 'pipe',
            windowsHide: true,
        });
        if (result.exitCode !== 0)
            throw new Error(`Cannot protect Windows private storage: ${path}`);
    }
}

function pathOf(path: unknown): string | undefined {
    return typeof path === 'string'
        ? resolve(path)
        : path instanceof URL
          ? fileURLToPath(path)
          : undefined;
}
function modeOf(options: unknown): number | undefined {
    if (!options || typeof options !== 'object' || !('mode' in options))
        return undefined;
    return typeof options.mode === 'number' ? options.mode : undefined;
}

export const chmod: typeof fs.chmod = async (path, mode) => {
    await fs.chmod(path, mode);
    if (process.platform === 'win32' && (mode === 0o600 || mode === 0o700))
        protect(pathOf(path) as string, sync.statSync(path).isDirectory());
};
export const chmodSync: typeof sync.chmodSync = (path, mode) => {
    sync.chmodSync(path, mode);
    if (process.platform === 'win32' && (mode === 0o600 || mode === 0o700))
        protect(pathOf(path) as string, sync.statSync(path).isDirectory());
};
export const writeFile: typeof fs.writeFile = async (path, data, options) => {
    await fs.writeFile(path, data, options);
    const physical = pathOf(path);
    if (process.platform === 'win32' && physical && modeOf(options) === 0o600)
        protect(physical, false);
};
export const writeFileSync: typeof sync.writeFileSync = (path, data, options) => {
    sync.writeFileSync(path, data, options);
    const physical = pathOf(path);
    if (process.platform === 'win32' && physical && modeOf(options) === 0o600)
        protect(physical, false);
};

/** ACL validation for the host-only secret store; values never enter the script. */
export function isPrivateWindowsFile(path: string): boolean {
    if (process.platform !== 'win32') return true;
    const script = [
        "$ErrorActionPreference = 'Stop'",
        "$ProgressPreference = 'SilentlyContinue'",
        '$acl = [IO.File]::GetAccessControl($env:WORKBENCH_ACL_PATH)',
        '$ids = @($acl.Access | Where-Object { $_.AccessControlType -eq "Allow" } | ForEach-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value })',
        'ConvertTo-Json -Compress -InputObject $ids',
    ].join('\n');
    const result = Bun.spawnSync(
        [
            systemTool('WindowsPowerShell\\v1.0\\powershell.exe'),
            '-NoProfile',
            '-NonInteractive',
            '-InputFormat',
            'None',
            '-EncodedCommand',
            Buffer.from(script, 'utf16le').toString('base64'),
        ],
        { env: { ...process.env, WORKBENCH_ACL_PATH: path }, windowsHide: true }
    );
    if (result.exitCode !== 0) return false;
    try {
        const ids: unknown = JSON.parse(new TextDecoder().decode(result.stdout));
        return (
            Array.isArray(ids) &&
            ids.length > 0 &&
            ids.every(
                (id) => id === sid() || id === 'S-1-5-18' || id === 'S-1-5-32-544'
            )
        );
    } catch {
        return false;
    }
}
