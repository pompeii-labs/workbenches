// Container plumbing. Every path comes from configuration, so this runs on any machine.
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

export const LABEL = 'workbenchmark.trial';

export interface Paths {
    /** Where trials are staged and torn down. */
    work: string;
    /** Saved image tarballs, so parallel trials never stream `docker save` at once. */
    imageCache: string;
    /** CLI assets. Never mounted into either actor. */
    bench: string;
    tasks: string;
    workbenches: string;
    results: string;
}

export interface RunResult {
    code: number;
    stdout: string;
    stderr: string;
    timedOut: boolean;
}

export async function exec(
    command: string[],
    options: {
        timeoutMs?: number;
        stdoutFile?: string;
        onTimeout?: () => Promise<void>;
    } = {}
): Promise<RunResult> {
    const child = Bun.spawn(command, {
        stdout: options.stdoutFile ? Bun.file(options.stdoutFile) : 'pipe',
        stderr: 'pipe',
    });
    let timedOut = false;
    const timer = options.timeoutMs
        ? setTimeout(async () => {
              timedOut = true;
              try {
                  await options.onTimeout?.();
              } catch {
                  // Process termination must still happen if container cleanup fails.
              } finally {
                  child.kill('SIGKILL');
              }
          }, options.timeoutMs)
        : undefined;
    const [stdout, stderr, code] = await Promise.all([
        options.stdoutFile
            ? Promise.resolve('')
            : new Response(child.stdout as ReadableStream).text(),
        new Response(child.stderr).text(),
        child.exited,
    ]);
    if (timer) clearTimeout(timer);
    return { code, stdout, stderr, timedOut };
}

export const sh = (command: string, timeoutMs = 600_000) =>
    exec(['bash', '-c', command], { timeoutMs });
export const quote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;

export async function docker(args: string[], timeoutMs = 600_000): Promise<string> {
    const result = await exec(['docker', ...args], { timeoutMs });
    if (result.code !== 0)
        throw new Error(
            `docker ${args[0]} failed: ${result.stderr.trim().slice(-500)}`
        );
    return result.stdout.trim();
}

/** Short daemon-local path, independent of host path length or filesystem socket support. */
export const socketPath = (_workDir?: string) => '/run/workbenchmark/docker.sock';

/**
 * A trial-private Docker daemon. Everything the agent or grader starts lives inside it.
 *
 * It listens on a Unix socket rather than TCP because a Workbench that declares a host
 * engine binding requires one: wb resolves the active Docker context and rejects a TCP
 * endpoint. Privileged DinD separates trial resources, but is not a security sandbox.
 */
export async function startDaemon(
    name: string,
    trial: string,
    workDir: string
): Promise<void> {
    const socket = socketPath(workDir);
    mkdirSync(workDir, { recursive: true });
    await docker([
        'run',
        '-d',
        '--platform',
        'linux/amd64',
        '--privileged',
        '--cgroupns',
        'private',
        '--tmpfs',
        '/run/workbenchmark:mode=0755',
        '--cpus',
        '4',
        '--memory',
        '8g',
        '--pids-limit',
        '2048',
        '--name',
        name,
        '--label',
        `${LABEL}=${trial}`,
        '-e',
        'DOCKER_TLS_CERTDIR=',
        '-v',
        `${workDir}:${workDir}`,
        'docker:29.1.3-dind',
        `--host=unix://${socket}`,
    ]);
    for (let i = 0; i < 180; i++) {
        if (
            (
                await exec(
                    [
                        'docker',
                        'exec',
                        name,
                        'docker',
                        '-H',
                        `unix://${socket}`,
                        'info',
                    ],
                    { timeoutMs: 10_000 }
                )
            ).code === 0
        ) {
            // Containers run as an unprivileged user; the daemon creates the socket as root.
            await exec(['docker', 'exec', name, 'chmod', '666', socket]);
            return;
        }
        const state = await docker(['inspect', '--format', '{{.State.Status}}', name]);
        if (state === 'exited' || state === 'dead') {
            const logs = await exec(['docker', 'logs', '--tail', '20', name]);
            throw new Error(
                `Private daemon failed to start: ${logs.stderr || logs.stdout}`
            );
        }
        await Bun.sleep(1000);
    }
    throw new Error(`Docker daemon ${name} did not become ready`);
}

export async function preloadImages(
    paths: Paths,
    daemon: string,
    images: string[]
): Promise<void> {
    mkdirSync(paths.imageCache, { recursive: true });
    for (const image of images) {
        if ((await exec(['docker', 'image', 'inspect', image])).code !== 0)
            await docker(['pull', image], 1_800_000);
        const id = (await docker(['image', 'inspect', '--format', '{{.Id}}', image]))
            .replace('sha256:', '')
            .slice(0, 16);
        const file = join(
            paths.imageCache,
            `${image.replace(/[^A-Za-z0-9_.-]/g, '_')}-${id}.tar`
        );
        if (!existsSync(file)) {
            const partial = `${file}.${crypto.randomUUID().slice(0, 8)}.partial`;
            const saved = await exec(['docker', 'save', '-o', partial, image], {
                timeoutMs: 1_800_000,
            });
            if (saved.code !== 0)
                throw new Error(`saving ${image} failed: ${saved.stderr.slice(-300)}`);
            renameSync(partial, file);
        }
        const load = await sh(
            `docker exec -i ${quote(daemon)} docker -H ${quote(`unix://${socketPath()}`)} load < ${quote(file)}`,
            1_800_000
        );
        if (load.code !== 0)
            throw new Error(`preloading ${image} failed: ${load.stderr.slice(-300)}`);
    }
}

export async function removeTrial(trial: string): Promise<void> {
    const ids = await docker(['ps', '-aq', '--filter', `label=${LABEL}=${trial}`]);
    if (ids) await docker(['rm', '-f', '-v', ...ids.split('\n')]);
}

export async function leftovers(trial?: string): Promise<string[]> {
    const out = await docker([
        'ps',
        '-a',
        '--filter',
        trial ? `label=${LABEL}=${trial}` : `label=${LABEL}`,
        '--format',
        '{{.Names}}',
    ]);
    return out.split('\n').filter(Boolean);
}

/** Removes a work directory including files nested containers created as another user. */
export async function removeWork(dir: string): Promise<void> {
    if (
        !basename(dir).startsWith('trial-') &&
        !basename(dir).startsWith('grade-') &&
        !basename(dir).startsWith('prepare-')
    )
        throw new Error(`Refusing unowned cleanup: ${dir}`);
    if (resolve(dir) === '/' || resolve(dir) === resolve(dirname(dir)))
        throw new Error('Invalid cleanup target');
    if (!existsSync(dir)) return;
    await exec([
        'docker',
        'run',
        '--rm',
        '-v',
        `${dir}:/owned`,
        'alpine:3.22',
        'sh',
        '-c',
        'find /owned -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +',
    ]);
    rmSync(dir, { recursive: true, force: true });
}

/**
 * Removes a directory staged inside a work directory. Setup containers run as
 * root, so what they leave behind cannot always be removed by the host user;
 * fall back to removing it through a container.
 */
export async function removeStaged(dir: string): Promise<void> {
    const parent = basename(dirname(dir));
    if (
        !parent.startsWith('trial-') &&
        !parent.startsWith('grade-') &&
        !parent.startsWith('prepare-')
    )
        throw new Error(`Refusing unowned cleanup: ${dir}`);
    if (!existsSync(dir)) return;
    try {
        rmSync(dir, { recursive: true, force: true });
    } catch {
        await exec([
            'docker',
            'run',
            '--rm',
            '-v',
            `${dir}:/owned`,
            'alpine:3.22',
            'sh',
            '-c',
            'find /owned -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +',
        ]);
        rmSync(dir, { recursive: true, force: true });
    }
}
