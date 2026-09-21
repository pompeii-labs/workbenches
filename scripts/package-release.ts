import { chmod, copyFile, mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { resolveReleaseTarget } from './release-support.js';

const root = resolve(import.meta.dir, '..');
const target = resolveReleaseTarget();
const dist = join(root, 'dist');
const release = join(dist, 'release');
const staging = join(release, target.name);
const archive = join(release, `${target.name}.tar.gz`);
const executable = target.executable;

await rm(release, { recursive: true, force: true });
await run([process.execPath, 'scripts/build.ts'], root);
await mkdir(staging, { recursive: true });
await copyFile(join(dist, executable), join(staging, executable));
if (target.os !== 'windows') await chmod(join(staging, executable), 0o755);
await Promise.all([
    copyFile(join(root, 'LICENSE'), join(staging, 'LICENSE')),
    copyFile(join(root, 'NOTICE'), join(staging, 'NOTICE')),
]);
await run([join(staging, executable), '--help'], root);
await run([process.execPath, 'test', 'test/release.test.ts'], root, {
    ...process.env,
    WORKBENCH_TEST_BINARY: join(staging, executable),
});
if (target.os === 'windows')
    await run([process.execPath, 'test', 'test/windows.install.test.ts'], root);
await run(['tar', '-czf', archive, '-C', release, target.name], root);

console.log(archive);

async function run(
    command: string[],
    cwd: string,
    env: Record<string, string | undefined> = process.env
): Promise<void> {
    const child = Bun.spawn(command, {
        cwd,
        env,
        stdin: 'ignore',
        stdout: 'ignore',
        stderr: 'inherit',
    });
    const code = await child.exited;
    if (code !== 0) {
        throw new Error(`Command exited with code ${code}: ${command.join(' ')}`);
    }
}
