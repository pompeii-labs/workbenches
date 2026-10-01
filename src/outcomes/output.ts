import { lstat, mkdir, readdir, readFile, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';

import type { CollectedOutput, OutcomeSink } from './collection.js';
import type { DeclaredOutcome } from './contracts.js';
import {
    DeclaredOutput,
    maximumDeclarationBytes,
    outcomeDeclarationName,
    parseDeclarationSource,
} from './declared.js';
import { outcomeStorageDirectory } from './directories.js';
import { OutcomeFiles } from './files.js';
import { assertOutcomeRunId } from './validation.js';

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

    async collect(store: OutcomeSink): Promise<CollectedOutput> {
        const declaration = await this.declaration();
        const files = new OutcomeFiles(store);
        return new DeclaredOutput({
            put: (path, mediaType) => files.put(join(this.directory, path), mediaType),
        }).assemble({ declaration, paths: await walkFiles(this.directory) });
    }

    cleanup(): Promise<void> {
        return this.owned
            ? rm(this.directory, { recursive: true, force: true })
            : Promise.resolve();
    }

    private async declaration(): Promise<DeclaredOutcome | undefined> {
        const path = join(this.directory, outcomeDeclarationName);
        const details = await lstat(path).catch(() => undefined);
        if (!details) return undefined;
        if (details.isSymbolicLink() || !details.isFile()) {
            throw new Error('Outcome declaration must be a regular file');
        }
        if (details.size > maximumDeclarationBytes) {
            throw new Error('Outcome declaration exceeds the 1 MiB safety limit');
        }
        return parseDeclarationSource(await readFile(path, 'utf8'));
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
        if (path === outcomeDeclarationName) continue;
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
