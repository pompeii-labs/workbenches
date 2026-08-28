import { readdir, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

import { GitHubWorkbenchSource } from '../sources/index.js';
import type { ResolvedWorkbench } from '../types.js';
import { Workbench } from './workbench.js';

export interface LocalWorkbenchSource {
    directory: string;
    source: string;
    revision?: string;
}

export interface WorkbenchReference {
    source: string;
    selector?: string;
}

export class WorkbenchSource {
    readonly #github = new GitHubWorkbenchSource();

    constructor(private readonly cwd = process.cwd()) {}

    parse(value: string): WorkbenchReference {
        const marker = value.lastIndexOf('#');
        if (marker < 0) return { source: value };

        const source = value.slice(0, marker);
        const selector = value.slice(marker + 1);
        if (!source || !selector) {
            throw new Error(`Invalid Workbench reference: ${value}`);
        }
        return { source, selector };
    }

    async local(source: string): Promise<LocalWorkbenchSource | undefined> {
        if (this.isRemote(source)) return undefined;

        const local = resolve(this.cwd, source);
        if (!(await stat(local).catch(() => null))) {
            if (this.looksLocal(source)) {
                throw new Error(`Workbench path does not exist: ${local}`);
            }
            return undefined;
        }

        const revision = await this.gitRevision(local);
        return {
            directory: local,
            source: local,
            ...(revision ? { revision } : {}),
        };
    }

    remote(source: string) {
        return this.#github.repository(source);
    }

    async discover(sourceDirectory: string): Promise<ResolvedWorkbench[]> {
        const details = await stat(sourceDirectory);
        if (details.isFile() || (await this.isManifestDirectory(sourceDirectory))) {
            return [await Workbench.load(sourceDirectory)];
        }

        const root = join(sourceDirectory, '.workbenches');
        const entries = await readdir(root, { withFileTypes: true }).catch(() => null);
        if (!entries) return [];

        const directories = entries
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name)
            .sort();
        return Promise.all(directories.map((name) => Workbench.load(join(root, name))));
    }

    async select(
        sourceDirectory: string,
        selector?: string
    ): Promise<ResolvedWorkbench> {
        const workbenches = await this.discover(sourceDirectory);
        if (workbenches.length === 0) {
            throw new Error(`No Workbenches found in ${sourceDirectory}`);
        }
        if (selector) {
            const selected = workbenches.find(
                (workbench) =>
                    basename(workbench.packageDirectory) === selector ||
                    workbench.manifest.name === selector
            );
            if (!selected) throw new Error(`Workbench not found: ${selector}`);
            return selected;
        }
        if (workbenches.length > 1) {
            throw new Error(
                `Workbench selector required. Available: ${workbenches
                    .map((workbench) => basename(workbench.packageDirectory))
                    .join(', ')}`
            );
        }
        return workbenches[0] as ResolvedWorkbench;
    }

    private isRemote(source: string): boolean {
        return /^https?:\/\//.test(source);
    }

    private looksLocal(source: string): boolean {
        return (
            source.startsWith('.') ||
            source.startsWith('/') ||
            source.startsWith('~') ||
            source.includes('\\')
        );
    }

    private async isManifestDirectory(directory: string): Promise<boolean> {
        return Boolean(
            (await stat(join(directory, 'workbench.yml')).catch(() => null))?.isFile()
        );
    }

    private async gitRevision(directory: string): Promise<string | undefined> {
        const child = Bun.spawn(['git', '-C', directory, 'rev-parse', 'HEAD'], {
            stdout: 'pipe',
            stderr: 'ignore',
        });
        const [code, output] = await Promise.all([
            child.exited,
            new Response(child.stdout).text(),
        ]);
        return code === 0 ? output.trim() : undefined;
    }
}
