import { createHash } from 'node:crypto';
import {
    cpSync,
    existsSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import type { Paths } from './runtime.ts';
import { identifier, type TaskSpec } from './spec.ts';
import { fingerprint } from './trial.ts';

const ignored = new Set(['node_modules', '.git', 'results', '.work', '.image-cache']);
const digest = (path: string) =>
    createHash('sha256').update(readFileSync(path)).digest('hex');

/** Retain the executable protocol, not just hashes of a mutable working copy. */
export function retainCampaignSource(
    paths: Paths,
    tasks: TaskSpec[],
    directory: string
) {
    const members = new Map<string, string>([
        ['workbenchmark.ts', join(paths.bench, 'workbenchmark.ts')],
        ['package.json', join(paths.bench, 'package.json')],
        ['lib', join(paths.bench, 'lib')],
        ['.workbenches/grader', join(paths.workbenches, 'grader')],
    ]);
    for (const task of tasks) {
        identifier(task.id, 'task');
        identifier(task.workbench, 'workbench');
        members.set(`tasks/${task.id}`, join(paths.tasks, task.id));
        members.set(
            `.workbenches/${task.workbench}`,
            join(paths.workbenches, task.workbench)
        );
    }
    const archive = join(directory, 'protocol-source.tar.gz');
    if (existsSync(archive) || existsSync(join(directory, 'protocol-source.json')))
        throw new Error(
            'Campaign source snapshot already exists; start a new campaign'
        );
    const staging = mkdtempSync(join(directory, '.source-build-'));
    try {
        const fingerprints: Record<string, string> = {};
        const files: Record<string, string> = {};
        for (const [name, source] of members) {
            const target = join(staging, name);
            mkdirSync(join(target, '..'), { recursive: true });
            cpSync(source, target, {
                recursive: true,
                filter(path) {
                    const name = basename(path);
                    if (path !== source && ignored.has(name)) return false;
                    if (lstatSync(path).isSymbolicLink())
                        throw new Error(
                            `Protocol source symlink is not supported: ${path}`
                        );
                    if (
                        name.startsWith('.env') &&
                        !['.env.example', '.env.sample'].includes(name)
                    )
                        throw new Error(
                            `Remove credential environment files from benchmark source before running: ${path}`
                        );
                    return true;
                },
            });
            if (lstatSync(source).isDirectory()) {
                fingerprints[name] = fingerprint(source);
                if (fingerprint(target) !== fingerprints[name])
                    throw new Error(
                        `Protocol source changed while capturing: ${source}`
                    );
            } else {
                files[name] = digest(source);
                if (digest(target) !== files[name])
                    throw new Error(
                        `Protocol source changed while capturing: ${source}`
                    );
            }
        }
        const packed = Bun.spawnSync(['tar', '-czf', archive, '-C', staging, '.']);
        if (packed.exitCode !== 0)
            throw new Error(
                `Protocol archive failed: ${packed.stderr.toString().slice(-1000)}`
            );
        writeFileSync(
            join(directory, 'protocol-source.json'),
            JSON.stringify(
                {
                    version: 1,
                    captured_at: new Date().toISOString(),
                    archive: 'protocol-source.tar.gz',
                    sha256: digest(archive),
                    members: [...members.keys()],
                    fingerprints,
                    files,
                },
                null,
                2
            ) + '\n'
        );
    } finally {
        rmSync(staging, { recursive: true, force: true });
    }
}
