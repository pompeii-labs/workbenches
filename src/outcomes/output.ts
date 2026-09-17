import { lstat, mkdir, readdir, readFile, realpath, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';

import type { DeclaredOutcome, OutcomeArtifact, OutcomeLink } from './contracts.js';
import { outcomeStorageDirectory } from './directories.js';
import { inferMediaType, type OutcomeStore } from './store.js';
import { assertOutcomeRunId, parseDeclaredOutcome } from './validation.js';

const declarationName = 'outcome.json';
const maximumDeclarationBytes = 1_024 * 1_024;

export interface CollectedOutput {
    summary?: string;
    artifacts: OutcomeArtifact[];
    links: OutcomeLink[];
}

export class OutcomeOutput {
    private constructor(
        readonly directory: string,
        private readonly owned = false
    ) {}

    static async create(home: string, runId: string): Promise<OutcomeOutput> {
        assertOutcomeRunId(runId);
        await outcomeStorageDirectory(home, ['runs', runId], true);
        const directory = join(home, 'runs', runId, 'outbox');
        // Never adopt or replace an earlier attempt's existing deliverables.
        await mkdir(directory, { mode: 0o700 });
        try {
            return new OutcomeOutput(await realpath(directory), true);
        } catch (error) {
            await rm(directory, { recursive: true, force: true });
            throw error;
        }
    }

    static open(directory: string): OutcomeOutput {
        return new OutcomeOutput(directory);
    }

    async collect(store: OutcomeStore): Promise<CollectedOutput> {
        const declaration = await this.declaration();
        const metadata = new Map(
            (declaration?.artifacts ?? []).map((artifact) => [artifact.path, artifact])
        );
        if (metadata.size !== (declaration?.artifacts?.length ?? 0)) {
            throw new Error('Declared outcome artifact paths must be unique');
        }
        const paths = await walkFiles(this.directory);
        for (const path of metadata.keys()) {
            if (!paths.includes(path)) {
                throw new Error(`Declared outcome artifact does not exist: ${path}`);
            }
        }
        const artifacts: OutcomeArtifact[] = [];
        for (const [index, path] of paths.entries()) {
            const declared = metadata.get(path);
            artifacts.push({
                id: uniqueId('artifact', declared?.name ?? path, index),
                name: declared?.name ?? path,
                path,
                content: await store.putFile(
                    join(this.directory, path),
                    declared?.media_type ?? inferMediaType(path)
                ),
                ...(declared?.description ? { description: declared.description } : {}),
            });
        }
        const links = (declaration?.links ?? []).map((link, index) => ({
            id: uniqueId('link', link.label, index),
            ...link,
        }));
        return {
            ...(declaration?.summary ? { summary: declaration.summary } : {}),
            artifacts,
            links,
        };
    }

    cleanup(): Promise<void> {
        return this.owned
            ? rm(this.directory, { recursive: true, force: true })
            : Promise.resolve();
    }

    private async declaration(): Promise<DeclaredOutcome | undefined> {
        const path = join(this.directory, declarationName);
        const details = await lstat(path).catch(() => undefined);
        if (!details) return undefined;
        if (details.isSymbolicLink() || !details.isFile()) {
            throw new Error('Outcome declaration must be a regular file');
        }
        if (details.size > maximumDeclarationBytes) {
            throw new Error('Outcome declaration exceeds the 1 MiB safety limit');
        }
        let value: unknown;
        try {
            value = JSON.parse(await readFile(path, 'utf8'));
        } catch (error) {
            throw new Error(
                `Outcome declaration is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
            );
        }
        return parseDeclaredOutcome(value);
    }
}

async function walkFiles(root: string, prefix = ''): Promise<string[]> {
    const entries = await readdir(prefix ? join(root, prefix) : root, {
        withFileTypes: true,
    });
    const paths: string[] = [];
    for (const entry of entries.toSorted((left, right) =>
        left.name.localeCompare(right.name)
    )) {
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (path === declarationName) continue;
        if (entry.isSymbolicLink()) {
            throw new Error(`Outcome artifacts cannot be symlinks: ${path}`);
        }
        if (entry.isDirectory()) {
            paths.push(...(await walkFiles(root, path)));
        } else if (entry.isFile()) {
            paths.push(path);
        } else {
            throw new Error(`Unsupported outcome artifact: ${path}`);
        }
    }
    return paths;
}

function uniqueId(prefix: string, value: string, index: number): string {
    const slug = basename(value)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 80);
    return `${prefix}_${slug || 'output'}_${index + 1}`;
}
