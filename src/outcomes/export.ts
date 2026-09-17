import { randomBytes } from 'node:crypto';
import {
    chmod,
    copyFile,
    lstat,
    mkdir,
    readdir,
    rename,
    rm,
    symlink,
    writeFile,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { RunOutcome } from './contracts.js';
import { assertArtifactPaths, outcomeArtifactPath } from './paths.js';
import type { OutcomeStore } from './store.js';
import { assertSafeOutcomePath } from './validation.js';

export class OutcomeExporter {
    constructor(private readonly store: Pick<OutcomeStore, 'blob'>) {}

    async export(outcome: RunOutcome, destination: string): Promise<string> {
        assertArtifactPaths(outcome.artifacts);
        const target = resolve(destination);
        if (await lstat(target).catch(() => undefined)) {
            throw new Error(`Outcome export destination already exists: ${target}`);
        }
        await mkdir(dirname(target), { recursive: true });
        const temporary = `${target}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
        let claimed = false;
        try {
            await mkdir(temporary, { recursive: false, mode: 0o700 });
            await writeFile(
                join(temporary, 'outcome.json'),
                `${JSON.stringify(outcome, null, 2)}\n`,
                { mode: 0o600 }
            );
            for (const changeset of outcome.changesets) {
                const root = join(temporary, 'changesets', changeset.id);
                if (changeset.review) {
                    await materializeFile(
                        await this.store.blob(changeset.review),
                        join(root, 'changes.diff'),
                        0o600
                    );
                }
                for (const entry of changeset.entries) {
                    if (!entry.after) continue;
                    const path = assertSafeOutcomePath(entry.path);
                    const destination = join(root, 'files', path);
                    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
                    if (entry.after.kind === 'file') {
                        await materializeFile(
                            await this.store.blob(entry.after.content),
                            destination,
                            entry.after.mode
                        );
                    } else {
                        await symlink(entry.after.target, destination);
                    }
                }
            }
            for (const artifact of outcome.artifacts) {
                await materializeFile(
                    await this.store.blob(artifact.content),
                    join(temporary, 'artifacts', outcomeArtifactPath(artifact)),
                    0o600
                );
            }
            // Directory rename can replace an empty destination created after
            // the initial check. Claim the final directory exclusively instead.
            await mkdir(target, { mode: 0o700 }).catch((error) => {
                if (
                    error instanceof Error &&
                    'code' in error &&
                    error.code === 'EEXIST'
                ) {
                    throw new Error(
                        `Outcome export destination already exists: ${target}`
                    );
                }
                throw error;
            });
            claimed = true;
            for (const entry of await readdir(temporary)) {
                await rename(join(temporary, entry), join(target, entry));
            }
            return target;
        } catch (error) {
            if (claimed) {
                const detail = error instanceof Error ? error.message : String(error);
                throw new Error(`Outcome export is incomplete at ${target}: ${detail}`);
            }
            throw error;
        } finally {
            await rm(temporary, { recursive: true, force: true });
        }
    }
}

async function materializeFile(
    source: string,
    destination: string,
    mode: number
): Promise<void> {
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await copyFile(source, destination);
    await chmod(destination, mode);
}
