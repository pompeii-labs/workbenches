import { readdir, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

import { WorkbenchSource } from '../workbench/index.js';

export interface ResolvedAuthoringTarget {
    repositoryDirectory: string;
    packageDirectory: string;
    selector: string;
}

export class AuthoringTarget {
    constructor(private readonly cwd = process.cwd()) {}

    async resolve(reference: string): Promise<ResolvedAuthoringTarget> {
        const source = new WorkbenchSource(this.cwd);
        const parsed = source.parse(reference);
        const local = await source.local(parsed.source);
        if (!local) {
            throw new Error(
                'Workbench editing requires a local repository path or selector'
            );
        }
        const input = local.directory;
        const details = await stat(input);
        if (details.isFile()) {
            if (basename(input) !== 'workbench.yml' || parsed.selector) {
                throw new Error(`Invalid local Workbench reference: ${reference}`);
            }
            return this.fromPackage(dirname(input));
        }
        if (!details.isDirectory()) {
            throw new Error(`Invalid local Workbench reference: ${reference}`);
        }
        if (basename(dirname(input)) === '.workbenches') {
            if (parsed.selector && parsed.selector !== basename(input)) {
                throw new Error(`Workbench not found: ${parsed.selector}`);
            }
            return this.fromPackage(input);
        }
        if (await this.manifestExists(input)) {
            if (parsed.selector && parsed.selector !== basename(input)) {
                throw new Error(`Workbench not found: ${parsed.selector}`);
            }
            return this.fromPackage(input);
        }
        return this.fromRepository(input, parsed.selector);
    }

    private async fromRepository(
        repository: string,
        selector?: string
    ): Promise<ResolvedAuthoringTarget> {
        const root = join(repository, '.workbenches');
        if (selector) {
            this.assertSelector(selector);
            const packageDirectory = join(root, selector);
            if (!(await stat(packageDirectory).catch(() => undefined))?.isDirectory()) {
                throw new Error(`Workbench not found: ${selector}`);
            }
            return { repositoryDirectory: repository, packageDirectory, selector };
        }
        const entries = await readdir(root, { withFileTypes: true }).catch((error) => {
            if (this.errorCode(error) === 'ENOENT') return [];
            throw error;
        });
        const directories = entries
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name)
            .toSorted();
        if (directories.length === 0) {
            throw new Error(`No Workbenches found in ${repository}`);
        }
        if (directories.length > 1) {
            throw new Error(
                `Workbench selector required. Available: ${directories.join(', ')}`
            );
        }
        const selected = directories[0] as string;
        return {
            repositoryDirectory: repository,
            packageDirectory: join(root, selected),
            selector: selected,
        };
    }

    private fromPackage(packageDirectory: string): ResolvedAuthoringTarget {
        const parent = dirname(packageDirectory);
        if (basename(parent) !== '.workbenches') {
            throw new Error('Workbench must live directly beneath .workbenches');
        }
        return {
            repositoryDirectory: dirname(parent),
            packageDirectory: resolve(packageDirectory),
            selector: basename(packageDirectory),
        };
    }

    private async manifestExists(directory: string): Promise<boolean> {
        return Boolean(
            (
                await stat(join(directory, 'workbench.yml')).catch(() => undefined)
            )?.isFile()
        );
    }

    private assertSelector(selector: string): void {
        if (
            selector === '.' ||
            selector === '..' ||
            basename(selector) !== selector ||
            selector.includes('\\')
        ) {
            throw new Error(`Invalid Workbench selector: ${selector}`);
        }
    }

    private errorCode(error: unknown): string | undefined {
        if (!error || typeof error !== 'object') return undefined;
        const code = Reflect.get(error, 'code');
        return typeof code === 'string' ? code : undefined;
    }
}
