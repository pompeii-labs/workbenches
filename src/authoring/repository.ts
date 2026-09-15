import { lstat, readdir, readFile, readlink } from 'node:fs/promises';
import { join } from 'node:path';

export interface RepositoryFileState {
    path: string;
    digest: string;
}

const fallbackExcludedDirectories = new Set(['.git', 'node_modules']);

export class AuthoringRepository {
    async snapshot(repository: string): Promise<RepositoryFileState[]> {
        const gitPaths = await this.gitFiles(repository);
        const paths = gitPaths
            ? [...new Set([...gitPaths, ...(await this.workbenchFiles(repository))])]
            : await this.files(repository);
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
        const previous = new Map(before.map((file) => [file.path, file.digest]));
        const current = new Map(after.map((file) => [file.path, file.digest]));
        return [...new Set([...previous.keys(), ...current.keys()])]
            .filter((path) => previous.get(path) !== current.get(path))
            .toSorted();
    }

    private async gitFiles(repository: string): Promise<string[] | undefined> {
        try {
            const child = Bun.spawn(
                [
                    'git',
                    '-C',
                    repository,
                    'ls-files',
                    '--cached',
                    '--others',
                    '--exclude-standard',
                    '-z',
                    '--',
                    '.',
                ],
                { stdout: 'pipe', stderr: 'ignore' }
            );
            const [exitCode, output] = await Promise.all([
                child.exited,
                new Response(child.stdout).text(),
            ]);
            if (exitCode !== 0) return undefined;
            return output
                .split('\0')
                .filter((path) => path.length > 0 && !path.startsWith('../'));
        } catch {
            return undefined;
        }
    }

    private async files(directory: string, relative = ''): Promise<string[]> {
        const entries = await readdir(join(directory, relative), {
            withFileTypes: true,
        });
        const paths: string[] = [];
        for (const entry of entries) {
            if (entry.isDirectory() && fallbackExcludedDirectories.has(entry.name)) {
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
