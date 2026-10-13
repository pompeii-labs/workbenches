import {
    chmod,
    copyFile,
    link as hardlink,
    symlink as link,
    mkdir,
    stat,
    writeFile,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

/** Windows reports only the read-only attribute, not POSIX owner/group modes. */
export function diskMode(mode: number): number {
    return process.platform === 'win32' ? (mode & 0o200 ? 0o666 : 0o444) : mode;
}

/** Node needs an explicit directory link type on Windows. */
export async function symlink(target: string, path: string): Promise<void> {
    const details = await stat(resolve(dirname(path), target)).catch(() => undefined);
    await link(target, path, details?.isDirectory() ? 'dir' : 'file');
}

/** A Bun script executable on either a POSIX shell or native Windows. */
let launcher: Promise<string> | undefined;
async function nativeLauncher(): Promise<string> {
    const root = resolve(
        import.meta.dir,
        '..',
        '.testing',
        `native-launcher-${process.pid}`
    );
    await mkdir(root, { recursive: true });
    const source = join(root, 'launcher.ts');
    const binary = join(root, 'launcher.exe');
    await writeFile(
        source,
        [
            'import { pathToFileURL } from "node:url";',
            'const script = process.execPath.replace(/\\.exe$/i, ".ts");',
            `process.execPath = ${JSON.stringify(process.execPath)};`,
            'await import(pathToFileURL(script).href);',
        ].join('\n')
    );
    const child = Bun.spawn(
        [
            process.execPath,
            'build',
            '--compile',
            '--no-compile-autoload-bunfig',
            '--no-compile-autoload-dotenv',
            '--outfile',
            binary,
            source,
        ],
        { stdout: 'ignore', stderr: 'pipe' }
    );
    const error = await new Response(child.stderr).text();
    if ((await child.exited) !== 0) throw new Error(error);
    return binary;
}
export async function executableScript(path: string): Promise<void> {
    await chmod(path, 0o755);
    if (process.platform === 'win32') {
        launcher ??= nativeLauncher();
        await copyFile(path, `${path}.ts`);
        try {
            await hardlink(await launcher, `${path}.exe`);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
            await copyFile(await launcher, `${path}.exe`);
        }
    }
}

/** Expose read access explicitly on Windows so privacy validation is tested against the ACL. */
export async function exposeFile(path: string): Promise<void> {
    if (process.platform !== 'win32') {
        await chmod(path, 0o644);
        return;
    }
    const result = Bun.spawnSync(['icacls.exe', path, '/grant', '*S-1-1-0:R'], {
        stdout: 'ignore',
        stderr: 'pipe',
    });
    if (result.exitCode !== 0) throw new Error('Could not expose fixture ACL');
}

/** Verify Linux sandbox scripts with the POSIX tools supplied by Git for Windows. */
export async function posixShell(script: string): Promise<string[]> {
    if (process.platform !== 'win32') return ['sh', '-c', script];
    const git = Bun.which('git');
    if (!git) throw new Error('Git is required to verify Linux collection scripts');
    const candidates = [
        join(dirname(git), '..', 'bin', 'bash.exe'),
        join(dirname(git), '..', '..', 'bin', 'bash.exe'),
        join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe'),
    ];
    const bash = candidates.find((path) => Bun.file(path).size > 0);
    if (!bash)
        throw new Error(
            'Git for Windows Bash is required to verify Linux collection scripts'
        );
    const command = script
        .replaceAll('\\', '/')
        .replace(/\b([A-Za-z]):\//g, (_, drive: string) => `/${drive.toLowerCase()}/`);
    return [bash, '--noprofile', '--norc', '-c', command];
}

/** The runner argv inside an engine setup wrapper, for protocol assertions. */
export function nativeCommand(input: string[]): string[] {
    let command = input;
    while (command.includes('-EncodedCommand')) {
        const script = Buffer.from(
            command[command.indexOf('-EncodedCommand') + 1] as string,
            'base64'
        ).toString('utf16le');
        const launch = script
            .split('\n')
            .findLast((line) => line.startsWith('& ') || line.includes(' | & '));
        if (!launch) break;
        command = [...launch.matchAll(/'((?:[^']|'')*)'/g)].map((match) =>
            (match[1] as string).replaceAll("''", "'")
        );
    }
    return command;
}
