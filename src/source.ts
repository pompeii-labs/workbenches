import { readdir, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

import { parseGitHubRepository } from './github.js';
import { resolveWorkbench } from './manifest.js';
import type { ResolvedWorkbench } from './types.js';

export interface LocalSource {
    directory: string;
    source: string;
    revision?: string;
}

export interface WorkbenchReference {
    source: string;
    selector?: string;
}

export function parseWorkbenchReference(value: string): WorkbenchReference {
    const marker = value.lastIndexOf('#');
    if (marker < 0) return { source: value };
    const source = value.slice(0, marker);
    const selector = value.slice(marker + 1);
    if (!source || !selector) throw new Error(`Invalid Workbench reference: ${value}`);
    return { source, selector };
}

export async function resolveLocalSource(
    source: string,
    cwd = process.cwd()
): Promise<LocalSource | undefined> {
    if (isRemoteSource(source)) return undefined;
    const local = resolve(cwd, source);
    if (!(await stat(local).catch(() => null))) {
        if (looksLikeLocalPath(source)) {
            throw new Error(`Workbench path does not exist: ${local}`);
        }
        return undefined;
    }
    const revision = await gitRevision(local);
    return {
        directory: local,
        source: local,
        ...(revision ? { revision } : {}),
    };
}

export function remoteSource(source: string): ReturnType<typeof parseGitHubRepository> {
    return parseGitHubRepository(source);
}

export async function discoverWorkbenches(
    sourceDirectory: string
): Promise<ResolvedWorkbench[]> {
    const details = await stat(sourceDirectory);
    if (details.isFile() || (await isManifestDirectory(sourceDirectory))) {
        return [await resolveWorkbench(sourceDirectory)];
    }

    const root = join(sourceDirectory, '.workbenches');
    const entries = await readdir(root, { withFileTypes: true }).catch(() => null);
    if (!entries) return [];
    const directories = (
        await Promise.all(
            entries
                .filter((entry) => entry.isDirectory())
                .map(async (entry) => {
                    if (
                        entry.name.endsWith('-draft') &&
                        !(await isManifestDirectory(join(root, entry.name)))
                    ) {
                        return undefined;
                    }
                    return entry.name;
                })
        )
    )
        .filter((name): name is string => name !== undefined)
        .sort();
    return Promise.all(directories.map((name) => resolveWorkbench(join(root, name))));
}

export async function selectWorkbench(
    sourceDirectory: string,
    selector?: string
): Promise<ResolvedWorkbench> {
    const workbenches = await discoverWorkbenches(sourceDirectory);
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

function isRemoteSource(source: string): boolean {
    return /^https?:\/\//.test(source);
}

function looksLikeLocalPath(source: string): boolean {
    return (
        source.startsWith('.') ||
        source.startsWith('/') ||
        source.startsWith('~') ||
        source.includes('\\')
    );
}

async function isManifestDirectory(directory: string): Promise<boolean> {
    return Boolean(
        (await stat(join(directory, 'workbench.yml')).catch(() => null))?.isFile()
    );
}

async function gitRevision(directory: string): Promise<string | undefined> {
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
