import { lstat, readdir, readFile, readlink } from 'node:fs/promises';
import { join } from 'node:path';

export interface RepositoryFileState {
    path: string;
    digest: string;
}

const excludedPackageDirectories = new Set(['.git', 'node_modules']);

export class AuthoringRepository {
    async snapshot(repository: string): Promise<RepositoryFileState[]> {
        // Authoring verification owns the Workbench collection, not the caller's
        // entire workspace. The creator may inspect a broad workspace, including an
        // umbrella directory containing several repositories, while its durable
        // output remains scoped to .workbenches. Recursively hashing the workspace
        // cannot attribute concurrent edits to the creator and becomes prohibitively
        // expensive for large directory trees.
        const paths = await this.workbenchFiles(repository);
        const states: RepositoryFileState[] = [];
        let index = 0;
        const workers = Array.from({ length: Math.min(paths.length, 16) }, async () => {
            while (index < paths.length) {
                const path = paths[index];
                index += 1;
                if (!path) continue;
                try {
                    states.push({
                        path,
                        digest: await this.digest(join(repository, path)),
                    });
                } catch (error) {
                    if (this.errorCode(error) !== 'ENOENT') throw error;
                }
            }
        });
        await Promise.all(workers);
        return states.toSorted((left, right) => left.path.localeCompare(right.path));
    }

    private async workbenchFiles(repository: string): Promise<string[]> {
        try {
            return (await this.files(join(repository, '.workbenches'))).map(
                (path) => `.workbenches/${path}`
            );
        } catch (error) {
            if (this.errorCode(error) === 'ENOENT') return [];
            throw error;
        }
    }

    changes(before: RepositoryFileState[], after: RepositoryFileState[]): string[] {
        const inCollection = (file: RepositoryFileState) =>
            file.path.startsWith('.workbenches/');
        const previous = new Map(
            before.filter(inCollection).map((file) => [file.path, file.digest])
        );
        const current = new Map(
            after.filter(inCollection).map((file) => [file.path, file.digest])
        );
        return [...new Set([...previous.keys(), ...current.keys()])]
            .filter((path) => previous.get(path) !== current.get(path))
            .toSorted();
    }

    private async files(directory: string, relative = ''): Promise<string[]> {
        const entries = await readdir(join(directory, relative), {
            withFileTypes: true,
        });
        const paths: string[] = [];
        for (const entry of entries) {
            if (entry.isDirectory() && excludedPackageDirectories.has(entry.name)) {
                continue;
            }
            const path = relative ? `${relative}/${entry.name}` : entry.name;
            if (entry.isDirectory()) paths.push(...(await this.files(directory, path)));
            else if (entry.isFile() || entry.isSymbolicLink()) paths.push(path);
        }
        return paths;
    }

    private async digest(path: string): Promise<string> {
        const details = await lstat(path);
        if (details.isSymbolicLink()) {
            return new Bun.CryptoHasher('sha256')
                .update(`symlink:${await readlink(path)}`)
                .digest('hex');
        }
        if (details.isDirectory()) return 'directory';
        const bytes = new Uint8Array(await readFile(path));
        return new Bun.CryptoHasher('sha256')
            .update(details.mode & 0o111 ? 'executable:' : 'file:')
            .update(bytes)
            .digest('hex');
    }

    private errorCode(error: unknown): string | undefined {
        if (!error || typeof error !== 'object') return undefined;
        const code = Reflect.get(error, 'code');
        return typeof code === 'string' ? code : undefined;
    }
}
