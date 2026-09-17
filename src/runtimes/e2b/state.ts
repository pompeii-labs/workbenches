import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
    chmod,
    lstat,
    mkdir,
    readdir,
    readFile,
    rename,
    rm,
    writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { OutcomeStorageLease } from '../../outcomes/lease.js';
import { extractArchive } from './snapshot.js';

const stateName = '.workbench-state';
interface StatePointer {
    version: 1;
    generation: string;
}
export interface E2BStateSource {
    directory: string;
    version: string;
}

/** Copy-on-write native state. Remote state never overwrites caller-owned files. */
export class E2BStateStore {
    private readonly root: string;
    constructor(private readonly directory: string) {
        this.root = join(directory, stateName);
    }

    async source(): Promise<E2BStateSource> {
        return this.withSource((source) => Promise.resolve(source));
    }

    async withSource<T>(operation: (source: E2BStateSource) => Promise<T>): Promise<T> {
        await this.prepare();
        return new OutcomeStorageLease(this.root).exclusive(async () =>
            operation(await this.sourceExclusive())
        );
    }

    async install(
        archive: string,
        expected: string,
        maximumBytes: number
    ): Promise<number> {
        await this.prepare();
        return new OutcomeStorageLease(this.root).exclusive(async () => {
            const current = await this.sourceExclusive();
            const generation = crypto.randomUUID();
            const destination = join(this.root, 'generations', generation);
            const pending = join(this.root, 'generations', `${generation}.pending`);
            await mkdir(pending, { mode: 0o700 });
            const pointerTemporary = join(this.root, `${generation}.json.tmp`);
            try {
                const bytes = await extractArchive(archive, pending, maximumBytes);
                await privatize(pending);
                if (
                    (await fingerprint(pending)) ===
                    (await fingerprint(current.directory))
                ) {
                    await rm(pending, { recursive: true, force: true });
                    return bytes;
                }
                if (current.version !== expected) {
                    throw new Error(
                        'Native E2B state changed during this run; remote state was not activated'
                    );
                }
                await rename(pending, destination);
                const pointer: StatePointer = { version: 1, generation };
                await writeFile(pointerTemporary, JSON.stringify(pointer), {
                    mode: 0o600,
                    flag: 'wx',
                });
                await rename(pointerTemporary, join(this.root, 'current.json'));
                // Keep one predecessor for interrupted staging. Never prune the canonical input.
                const previous = current.version.startsWith('generation:')
                    ? current.version.slice('generation:'.length)
                    : undefined;
                for (const entry of await readdir(join(this.root, 'generations'), {
                    withFileTypes: true,
                })) {
                    if (
                        entry.isDirectory() &&
                        /^[a-f0-9-]{36}$/.test(entry.name) &&
                        entry.name !== generation &&
                        entry.name !== previous
                    ) {
                        await rm(join(this.root, 'generations', entry.name), {
                            recursive: true,
                            force: true,
                        });
                    }
                }
                return bytes;
            } catch (error) {
                await rm(pending, { recursive: true, force: true });
                throw error;
            } finally {
                await rm(pointerTemporary, { force: true });
            }
        });
    }

    private async prepare(): Promise<void> {
        await requireDirectory(this.directory);
        await requireDirectory(this.root, true);
        await requireDirectory(join(this.root, 'generations'), true);
    }

    private async sourceExclusive(): Promise<E2BStateSource> {
        const pointerPath = join(this.root, 'current.json');
        const details = await lstat(pointerPath).catch(() => undefined);
        if (!details)
            return {
                directory: this.directory,
                version: await fingerprint(this.directory),
            };
        if (!details.isFile() || details.isSymbolicLink() || details.size > 1_024) {
            throw new Error('Invalid E2B native state pointer');
        }
        const value = JSON.parse(await readFile(pointerPath, 'utf8')) as StatePointer;
        if (value.version !== 1 || !/^[a-f0-9-]{36}$/.test(value.generation)) {
            throw new Error('Invalid E2B native state generation');
        }
        const directory = join(this.root, 'generations', value.generation);
        await requireDirectory(directory);
        return { directory, version: `generation:${value.generation}` };
    }
}

async function requireDirectory(path: string, create = false): Promise<void> {
    if (create)
        await mkdir(path, { recursive: false, mode: 0o700 }).catch((error) => {
            if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST'))
                throw error;
        });
    const details = await lstat(path);
    if (!details.isDirectory() || details.isSymbolicLink())
        throw new Error('E2B native state must use real directories');
    await chmod(path, 0o700);
}

async function privatize(directory: string): Promise<void> {
    await chmod(directory, 0o700);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (
            entry.name === stateName ||
            entry.name === '.git' ||
            entry.isSymbolicLink()
        ) {
            throw new Error(
                'Remote native state contains unsupported metadata or symlinks'
            );
        }
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await privatize(path);
        else if (entry.isFile()) await chmod(path, 0o600);
        else throw new Error('Remote native state contains a non-regular file');
    }
}

async function fingerprint(directory: string): Promise<string> {
    const hash = createHash('sha256');
    const visit = async (root: string, prefix = ''): Promise<void> => {
        for (const entry of (await readdir(root, { withFileTypes: true })).toSorted(
            (a, b) => a.name.localeCompare(b.name)
        )) {
            if (entry.name === stateName || entry.name === '.git') continue;
            const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
            const path = join(root, entry.name);
            hash.update(`${relative}\0`);
            if (entry.isDirectory()) await visit(path, relative);
            else if (entry.isFile()) {
                const file = createHash('sha256');
                for await (const chunk of createReadStream(path)) file.update(chunk);
                hash.update(`${file.digest('hex')}\0`);
            } else
                throw new Error('E2B native state source contains a non-regular file');
        }
    };
    await visit(directory);
    return `sha256:${hash.digest('hex')}`;
}
