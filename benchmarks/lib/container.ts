// The low-level primitive shared by package staging, grading, and the trial
// runner: launching a container in a trial's private Docker daemon, and the
// small utilities every one of those callers needs (fingerprinting a
// directory, writing JSON evidence, running a must-succeed shell command).
import { createHash } from 'node:crypto';
import {
    cpSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    statSync,
    writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { exec, sh, socketPath } from './runtime.ts';
import type { Arm } from './spec.ts';
import { diagnosticTools } from './trace.ts';

export const DEFAULT_MODEL = 'openai/gpt-5.6-terra';
export const AGENT_IMAGE = 'workbenchmark-agent:dev';
export const ENGINE_IMAGE = 'workbenchmark-wb:dev';
export class InfraError extends Error {}

export const json = (path: string, value: unknown) =>
    writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });

export async function must(command: string) {
    const r = await sh(command);
    if (r.code !== 0)
        throw new InfraError(`Command exited ${r.code}: ${r.stderr.slice(-600)}`);
    return r.stdout;
}

export function fingerprint(directory: string): string {
    const hash = createHash('sha256');
    const visit = (dir: string, prefix = '') => {
        for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
            a.name.localeCompare(b.name)
        )) {
            if (
                ['node_modules', '.git', 'results', '.work', '.image-cache'].includes(
                    e.name
                )
            )
                continue;
            const path = join(dir, e.name),
                name = prefix + e.name;
            if (e.isSymbolicLink())
                throw new Error(`Package/task symlinks are not supported: ${path}`);
            if (e.isDirectory()) visit(path, name + '/');
            else if (e.isFile())
                hash.update(name)
                    .update('\0')
                    .update(String(statSync(path).mode & 0o777))
                    .update('\0')
                    .update(readFileSync(path))
                    .update('\0');
        }
    };
    visit(directory);
    return `sha256:${hash.digest('hex')}`;
}

export interface ContainerOptions {
    name: string;
    daemon: string;
    work: string;
    cwd: string;
    command: string[];
    image?: string;
    timeoutMs: number;
    stdoutFile?: string;
    credential?: boolean;
    network?: 'host' | 'none';
}
export async function runContainer(o: ContainerOptions) {
    const home = join(o.work, 'home'),
        // The engine launcher stages assets in TMPDIR and bind-mounts them through
        // the private daemon, so its TMPDIR must be on the shared work mount.
        // Every other container (gates, probes) keeps a short container-local
        // /tmp: Chromium refuses Unix socket paths longer than 108 bytes.
        tmp = o.image === ENGINE_IMAGE ? join(o.work, 'tmp') : '/tmp',
        socket = `unix://${socketPath(o.work)}`;
    mkdirSync(home, { recursive: true });
    if (tmp !== '/tmp') mkdirSync(tmp, { recursive: true });
    return exec(
        [
            'docker',
            'exec',
            ...(o.credential ? ['-e', 'OPENROUTER_API_KEY'] : []),
            o.daemon,
            'docker',
            '-H',
            socket,
            'run',
            '--rm',
            '--init',
            '--name',
            o.name,
            '--network',
            o.network ?? 'host',
            '--user',
            '0:0',
            '-e',
            `HOME=${home}`,
            '-e',
            `TMPDIR=${tmp}`,
            '-e',
            `PATH=${home}/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
            '-e',
            `WORKBENCH_HOME=${join(home, '.workbench')}`,
            '-e',
            `DOCKER_HOST=${socket}`,
            ...(o.credential ? ['-e', 'OPENROUTER_API_KEY'] : []),
            '-v',
            `${o.work}:${o.work}`,
            '-v',
            '/run/workbenchmark:/run/workbenchmark',
            '-w',
            o.cwd,
            o.image ?? AGENT_IMAGE,
            ...o.command,
        ],
        {
            timeoutMs: o.timeoutMs,
            stdoutFile: o.stdoutFile,
            onTimeout: async () => {
                // `wb` can launch a nested runner. Removing only this launcher
                // leaves that runner alive, so remove the exact owned daemon.
                // The mounted work directory remains available for snapshots.
                await removeTrialFromDaemon(o.daemon);
            },
        }
    );
}

export async function removeTrialFromDaemon(daemon: string) {
    if (!daemon.startsWith('wbm-trial-') && !daemon.startsWith('wbm-'))
        throw new InfraError(`Refusing to remove unowned daemon: ${daemon}`);
    await exec(['docker', 'rm', '-f', '-v', daemon], { timeoutMs: 30000 });
}

/** Diagnostic export only, after the timed model run. Never receives credentials. */
export async function retainNativeTrace(
    work: string,
    daemon: string,
    project: string,
    events: string,
    evidence: string,
    arm: Arm
) {
    const redact = (text: string) => {
        const key = process.env.OPENROUTER_API_KEY;
        return key ? text.replaceAll(key, '[REDACTED]') : text;
    };
    try {
        if (arm === 'plain') {
            const parts: unknown[] = [];
            for (const line of readFileSync(events, 'utf8').split('\n')) {
                try {
                    const event = JSON.parse(line);
                    if (event.type === 'tool_use' && event.part) parts.push(event.part);
                } catch {}
            }
            const trace = diagnosticTools({ messages: [{ parts }] });
            json(
                join(evidence, 'native-trace.json'),
                JSON.parse(redact(JSON.stringify(trace)))
            );
            json(join(evidence, 'native-trace.status.json'), {
                status: 'retained',
                sanitized: true,
                source: 'native-events',
            });
            return;
        }
        const script = join(work, 'trace-export.ts');
        cpSync(join(import.meta.dir, 'trace.ts'), script);
        const result = await runContainer({
            name: 'trace-export',
            daemon,
            work,
            cwd: project,
            command: ['bun', script, join(work, 'home'), arm],
            timeoutMs: 60000,
            network: 'none',
        });
        if (result.code !== 0)
            throw new Error(
                `Native export exited ${result.code}: ${redact(result.stderr).slice(-500)}`
            );
        const trace = JSON.parse(redact(result.stdout));
        json(join(evidence, 'native-trace.json'), trace);
        json(join(evidence, 'native-trace.status.json'), {
            status: 'retained',
            sanitized: true,
        });
    } catch (error) {
        json(join(evidence, 'native-trace.status.json'), {
            status: 'unavailable',
            error: redact(String(error)),
        });
        console.error(
            `Native diagnostic trace unavailable; see ${join(evidence, 'native-trace.status.json')}`
        );
    }
}
