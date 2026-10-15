import { createHash } from 'node:crypto';
import { copyFile, lstat, readFile, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { launchEnvironment } from '../platform/environment.js';

/** Replace both installer aliases together, retaining rollback bytes until both succeed. */
export async function replaceWindowsExecutable(
    source: string,
    target: string
): Promise<string> {
    const targets = [target];
    const name = basename(target).toLowerCase();
    if (name === 'wb.exe' || name === 'workbench.exe') {
        const alias = join(
            dirname(target),
            name === 'wb.exe' ? 'workbench.exe' : 'wb.exe'
        );
        const entry = await lstat(alias).catch(() => undefined);
        if (entry?.isFile() && !entry.isSymbolicLink()) {
            const digest = (bytes: Uint8Array) =>
                createHash('sha256').update(bytes).digest('hex');
            if (digest(await readFile(alias)) === digest(await readFile(target)))
                targets.push(alias);
        }
    }
    const token = crypto.randomUUID();
    const plans = targets.map((path) => ({
        path,
        staged: join(dirname(path), `.workbench-update-${token}-${basename(path)}`),
        backup: join(dirname(path), `.workbench-previous-${token}-${basename(path)}`),
        moved: false,
        installed: false,
    }));
    try {
        for (const plan of plans) await copyFile(source, plan.staged);
        for (const plan of plans) {
            await rename(plan.path, plan.backup);
            plan.moved = true;
            await rename(plan.staged, plan.path);
            plan.installed = true;
        }
    } catch (error) {
        for (const plan of [...plans].reverse()) {
            if (plan.installed) await rm(plan.path);
            if (plan.moved) await rename(plan.backup, plan.path);
        }
        throw new Error(
            `Could not replace the installed Workbench CLI: ${error instanceof Error ? error.message : String(error)}`
        );
    } finally {
        for (const plan of plans) await rm(plan.staged, { force: true });
    }
    for (const plan of plans) {
        await rm(plan.backup, { force: true }).catch((error: NodeJS.ErrnoException) => {
            if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code ?? '')) throw error;
            removeAfterExit(plan.backup);
        });
    }
    return target;
}

/** The old image stays locked while the updater's process runs. */
function removeAfterExit(backup: string): void {
    const script =
        'try { [Diagnostics.Process]::GetProcessById([int]$env:WORKBENCH_UPDATE_PID).WaitForExit() } catch {}; Remove-Item -LiteralPath $env:WORKBENCH_UPDATE_BACKUP -Force -ErrorAction SilentlyContinue';
    const child = Bun.spawn(
        [
            join(
                process.env.SystemRoot ?? 'C:\\Windows',
                'System32',
                'WindowsPowerShell',
                'v1.0',
                'powershell.exe'
            ),
            '-NoProfile',
            '-NonInteractive',
            '-InputFormat',
            'None',
            '-EncodedCommand',
            Buffer.from(script, 'utf16le').toString('base64'),
        ],
        {
            env: launchEnvironment({
                WORKBENCH_UPDATE_PID: String(process.pid),
                WORKBENCH_UPDATE_BACKUP: backup,
            }),
            stdin: 'ignore',
            stdout: 'ignore',
            stderr: 'ignore',
            detached: true,
            windowsHide: true,
        }
    );
    child.unref();
}
