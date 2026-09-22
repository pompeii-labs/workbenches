import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { renderMonitor } from './monitor.ts';
import { identifier } from './spec.ts';

export interface RemoteTarget {
    ssh: string;
    directory: string;
}
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
export function validateRemote(target: RemoteTarget): RemoteTarget {
    if (!/^[A-Za-z0-9_][A-Za-z0-9_.@-]*$/.test(target.ssh))
        throw new Error('Use an SSH config alias or user@hostname');
    if (!isAbsolute(target.directory) || /[\r\n\0]/.test(target.directory))
        throw new Error('--remote-dir must be an absolute host path');
    // Ignore obsolete executable overrides in previously saved campaign routes.
    return { ssh: target.ssh, directory: target.directory };
}
function routePath(results: string, campaign: string) {
    identifier(campaign, 'campaign');
    return join(results, campaign, 'remote.json');
}
export function savedRemote(
    results: string,
    campaign: string
): RemoteTarget | undefined {
    const path = routePath(results, campaign);
    if (!existsSync(path)) return;
    return validateRemote(JSON.parse(readFileSync(path, 'utf8')));
}
export function rememberRemote(
    results: string,
    campaign: string,
    target: RemoteTarget
) {
    target = validateRemote(target);
    const path = routePath(results, campaign);
    const existing = savedRemote(results, campaign);
    if (existing && JSON.stringify(existing) !== JSON.stringify(target))
        throw new Error('Campaign is already bound to another SSH target');
    if (existsSync(join(results, campaign, 'campaign.json')))
        throw new Error('Campaign name already belongs to a local run');
    mkdirSync(join(results, campaign), { recursive: true, mode: 0o700 });
    if (!existing)
        writeFileSync(path, JSON.stringify(target, null, 2) + '\n', {
            mode: 0o600,
            flag: 'wx',
        });
}
export function remoteArguments(args: string[]): string[] {
    const local = ['--ssh', '--remote-dir', '--results-dir'];
    const forwarded: string[] = [];
    for (let i = 0; i < args.length; i++) {
        const arg = args[i]!;
        if (local.includes(arg)) {
            i++;
            continue;
        }
        if (local.some((flag) => arg.startsWith(flag + '='))) continue;
        forwarded.push(arg);
    }
    return forwarded;
}
export function sshCommand(
    target: RemoteTarget,
    args: string[],
    paid: boolean
): string[] {
    validateRemote(target);
    const credential = paid
        ? 'IFS= read -r OPENROUTER_API_KEY || exit 1; export OPENROUTER_API_KEY; '
        : '';
    const resolveBun =
        'benchmark_bun=$(command -v bun) || benchmark_bun=""; ' +
        'if [ -z "$benchmark_bun" ] && [ -x "$HOME/.bun/bin/bun" ]; then benchmark_bun="$HOME/.bun/bin/bun"; fi; ' +
        'if [ -z "$benchmark_bun" ]; then echo "workbenchmark: Bun is not installed or discoverable on the SSH host. Install Bun on that host." >&2; exit 127; fi; ';
    return [
        'ssh',
        '-T',
        '-o',
        'BatchMode=yes',
        '-o',
        'ConnectTimeout=15',
        target.ssh,
        `cd ${quote(target.directory)} || exit 1; ${resolveBun}${credential}exec "$benchmark_bun" --no-env-file workbenchmark.ts ${args.map(quote).join(' ')}`,
    ];
}
export async function runRemote(
    target: RemoteTarget,
    args: string[],
    options: { monitor: boolean; json: boolean; once: boolean }
) {
    const paid = ['run', 'regrade', 'calibrate'].includes(args[0]!);
    const key = paid ? process.env.OPENROUTER_API_KEY : undefined;
    if (paid && (!key || /[\r\n\0]/.test(key)))
        throw new Error('Set OPENROUTER_API_KEY locally for remote model calls');
    const forward = remoteArguments(args);
    if (options.monitor && !forward.includes('--json')) forward.push('--json');
    const child = Bun.spawn(sshCommand(target, forward, paid), {
        stdin: paid ? 'pipe' : 'ignore',
        stdout: options.monitor ? 'pipe' : 'inherit',
        stderr: 'inherit',
    });
    if (paid && child.stdin && typeof child.stdin !== 'number') {
        child.stdin.write(key + '\n');
        child.stdin.end();
    }
    const stop = () => child.kill('SIGTERM');
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    try {
        if (options.monitor) {
            let pending = '';
            const decoder = new TextDecoder();
            for await (const chunk of child.stdout as ReadableStream<Uint8Array>) {
                pending += decoder.decode(chunk, { stream: true });
                for (
                    let at = pending.indexOf('\n');
                    at >= 0;
                    at = pending.indexOf('\n')
                ) {
                    const line = pending.slice(0, at);
                    pending = pending.slice(at + 1);
                    if (!line.trim()) continue;
                    const snapshot = JSON.parse(line);
                    if (options.json) console.log(JSON.stringify(snapshot));
                    else {
                        if (process.stdout.isTTY && !options.once)
                            process.stdout.write('\x1b[2J\x1b[H');
                        console.log(renderMonitor(snapshot));
                    }
                }
            }
        }
        const code = await child.exited;
        if (code !== 0)
            throw new Error(
                `SSH command ended with exit ${code}. Remote campaign state is unknown; do not restart blindly.`
            );
    } finally {
        if (child.exitCode === null) child.kill('SIGTERM');
        process.off('SIGINT', stop);
        process.off('SIGTERM', stop);
    }
}
