import { createHash } from 'node:crypto';
import {
    chmod,
    copyFile,
    cp,
    lstat,
    mkdtemp,
    readdir,
    readFile,
    readlink,
    realpath,
    rm,
    stat,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import type { ResolvedWorkbench } from '../../types.js';

export class DockerBuildContext {
    private constructor(
        readonly root: string,
        readonly context: string,
        readonly dockerfile: string,
        readonly digest: string,
        readonly excludedPaths: string[]
    ) {}

    static async stage(workbench: ResolvedWorkbench): Promise<DockerBuildContext> {
        const image = workbench.manifest.image;
        if (!image || typeof image === 'string') {
            throw new Error('Workbench does not declare a local image build');
        }
        const sourceContext = resolve(workbench.packageDirectory, image.context ?? '.');
        const sourceDockerfile = resolve(workbench.packageDirectory, image.build);
        const root = await mkdtemp(join(tmpdir(), 'workbench-docker-build-'));
        const context = join(root, 'context');
        const dockerfile = join(root, 'Dockerfile.workbench');
        const excludedPaths: string[] = [];
        try {
            const contextStat = await stat(sourceContext).catch(() => null);
            if (!contextStat?.isDirectory()) {
                throw new Error(
                    `Docker build context does not exist: ${image.context ?? '.'}`
                );
            }
            const dockerfileStat = await stat(sourceDockerfile).catch(() => null);
            if (!dockerfileStat?.isFile()) {
                throw new Error(`Dockerfile does not exist: ${image.build}`);
            }
            const repositoryDirectory = await realpath(workbench.repositoryDirectory);
            const buildContext = await realpath(sourceContext);
            const dockerfilePath = await realpath(sourceDockerfile);
            if (!contains(repositoryDirectory, buildContext)) {
                throw new Error(
                    `Docker build context resolves outside the repository: ${image.context ?? '.'}`
                );
            }
            if (!contains(repositoryDirectory, dockerfilePath)) {
                throw new Error(
                    `Dockerfile resolves outside the repository: ${image.build}`
                );
            }
            await cp(buildContext, context, {
                recursive: true,
                preserveTimestamps: true,
                verbatimSymlinks: true,
                filter: async (source) => {
                    const name = relative(buildContext, source);
                    if (!name) return true;
                    if (protectedPath(name)) {
                        excludedPaths.push(name);
                        return false;
                    }
                    const entry = await lstat(source);
                    if (entry.isSymbolicLink()) {
                        await validateSymlink(buildContext, source);
                    } else if (!entry.isDirectory() && !entry.isFile()) {
                        throw new Error(
                            `Unsupported file in Docker build context: ${name}`
                        );
                    }
                    return true;
                },
            });
            await copyFile(dockerfilePath, dockerfile);
            await chmod(dockerfile, 0o600);
            const digest = await digestInputs(context, dockerfile);
            return new DockerBuildContext(
                root,
                context,
                dockerfile,
                digest,
                [...new Set(excludedPaths)].toSorted()
            );
        } catch (error) {
            await rm(root, { recursive: true, force: true });
            throw error;
        }
    }

    async cleanup(): Promise<void> {
        await rm(this.root, { recursive: true, force: true });
    }
}

function contains(parent: string, child: string): boolean {
    const suffix = relative(parent, child);
    return (
        suffix === '' ||
        (!suffix.startsWith(`..${sep}`) && suffix !== '..' && !isAbsolute(suffix))
    );
}

function protectedPath(path: string): boolean {
    const segments = path.split(sep);
    if (
        segments.some((segment) =>
            ['.git', '.hg', '.svn', '.ssh', '.aws', '.gnupg'].includes(segment)
        )
    ) {
        return true;
    }
    const name = basename(path).toLowerCase();
    if (
        name === '.env' ||
        (name.startsWith('.env.') && !['.env.example', '.env.sample'].includes(name))
    ) {
        return true;
    }
    if (
        [
            '.npmrc',
            '.netrc',
            '.pypirc',
            'id_rsa',
            'id_ed25519',
            'credentials',
            'credentials.json',
        ].includes(name)
    ) {
        return true;
    }
    return ['.pem', '.key', '.p12', '.pfx', '.kubeconfig'].some((extension) =>
        name.endsWith(extension)
    );
}

async function validateSymlink(root: string, path: string): Promise<void> {
    const target = await readlink(path);
    if (isAbsolute(target)) {
        throw new Error(
            `Absolute symlink is not allowed in Docker build context: ${relative(root, path)}`
        );
    }
    const destination = resolve(dirname(path), target);
    if (!contains(root, destination)) {
        throw new Error(
            `Escaping symlink is not allowed in Docker build context: ${relative(root, path)}`
        );
    }
    await realpath(destination).catch(() => {
        throw new Error(
            `Broken symlink is not allowed in Docker build context: ${relative(root, path)}`
        );
    });
}

async function digestInputs(context: string, dockerfile: string): Promise<string> {
    const hash = createHash('sha256');
    hash.update('workbench-docker-context-v0\0');
    hash.update(await readFile(dockerfile));
    await hashDirectory(hash, context, '');
    return hash.digest('hex');
}

async function hashDirectory(
    hash: ReturnType<typeof createHash>,
    directory: string,
    prefix: string
): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.toSorted((left, right) =>
        left.name.localeCompare(right.name)
    )) {
        const path = join(directory, entry.name);
        const name = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
            hash.update(`d\0${name}\0`);
            await hashDirectory(hash, path, name);
        } else if (entry.isSymbolicLink()) {
            hash.update(`l\0${name}\0${await readlink(path)}\0`);
        } else if (entry.isFile()) {
            const metadata = await stat(path);
            hash.update(`f\0${name}\0${metadata.mode & 0o777}\0`);
            hash.update(await readFile(path));
            hash.update('\0');
        }
    }
}
