import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import packageMetadata from '../package.json' with { type: 'json' };

const binary = process.argv[2];
if (!binary) throw new Error('Release binary path is required');

const directory = await mkdtemp(join(tmpdir(), 'workbench-binary-'));
try {
    await writeFile(join(directory, 'bunfig.toml'), 'preload = ["./preload.ts"]\n');
    await writeFile(
        join(directory, 'preload.ts'),
        'throw new Error("Repository-defined preload executed on the host");\n'
    );
    const version = await execute(['--version']);
    verify(version, packageMetadata.version);

    await rm(join(directory, 'bunfig.toml'));
    await rm(join(directory, 'preload.ts'));
    await writeFile(join(directory, '.env'), 'WB_TELEMETRY_DISABLED=1\n');
    const dotenv = await execute(['telemetry', 'status']);
    verify(dotenv, 'anonymous run reporting: on');

    const inherited = await execute(['telemetry', 'status'], {
        WB_TELEMETRY_DISABLED: '1',
    });
    verify(inherited, 'anonymous run reporting: off');
} finally {
    await rm(directory, { recursive: true, force: true });
}

async function execute(
    args: string[],
    environment: Record<string, string> = {}
): Promise<{ code: number; stdout: string; stderr: string }> {
    const invocation = crypto.randomUUID();
    const stdoutPath = join(directory, `${invocation}.stdout`);
    const stderrPath = join(directory, `${invocation}.stderr`);
    const child = Bun.spawn([resolve(binary), ...args], {
        cwd: directory,
        env: {
            PATH: process.env.PATH,
            HOME: process.env.HOME,
            USERPROFILE: process.env.USERPROFILE,
            LOCALAPPDATA: process.env.LOCALAPPDATA,
            APPDATA: process.env.APPDATA,
            SystemRoot: process.env.SystemRoot,
            ComSpec: process.env.ComSpec,
            PATHEXT: process.env.PATHEXT,
            TEMP: process.env.TEMP,
            TMP: process.env.TMP,
            TERM: 'dumb',
            NO_COLOR: '1',
            WORKBENCH_HOME: join(directory, 'engine'),
            ...environment,
        },
        stdin: 'ignore',
        stdout: Bun.file(stdoutPath),
        stderr: Bun.file(stderrPath),
    });
    const code = await child.exited;
    const [stdout, stderr] = await Promise.all([
        Bun.file(stdoutPath).text(),
        Bun.file(stderrPath).text(),
    ]);
    await Promise.all([
        rm(stdoutPath, { force: true }),
        rm(stderrPath, { force: true }),
    ]);
    return { code, stdout, stderr };
}

function verify(
    result: { code: number; stdout: string; stderr: string },
    expected: string
) {
    if (result.code !== 0 || result.stdout.trim() !== expected || result.stderr) {
        throw new Error(
            `Release binary verification failed: ${JSON.stringify({ ...result, expected })}`
        );
    }
}
