import { basename } from 'node:path';

import type { CollectedOutput } from './collection.js';
import type {
    DeclaredOutcome,
    OutcomeArtifact,
    OutcomeContentDescriptor,
} from './contracts.js';
import { inferMediaType } from './media.js';
import { parseDeclaredOutcome } from './validation.js';

/** The file a runner writes into its outbox to describe what it returned. */
export const outcomeDeclarationName = 'outcome.json';
export const maximumDeclarationBytes = 1_024 * 1_024;

/** Parses the text of an `outcome.json` declaration. */
export function parseDeclarationSource(source: string): DeclaredOutcome {
    let value: unknown;
    try {
        value = JSON.parse(source);
    } catch (error) {
        throw new Error(
            `Outcome declaration is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
        );
    }
    return parseDeclaredOutcome(value);
}

/** Where the files of one outbox are stored, by their path inside the outbox. */
export interface OutboxContent {
    /** Stores one file's content and returns its descriptor. */
    put(path: string, mediaType: string): Promise<OutcomeContentDescriptor>;
}

/**
 * Turns an outbox listing and its optional declaration into artifacts and
 * links, storing each file through `content`. Reading the outbox is the
 * caller's job, so the same assembly serves a directory on disk and an archive
 * held in memory.
 */
export class DeclaredOutput {
    constructor(private readonly content: OutboxContent) {}

    /** `paths` are the outbox files other than the declaration. */
    async assemble(options: {
        declaration: DeclaredOutcome | undefined;
        paths: string[];
    }): Promise<CollectedOutput> {
        const { declaration, paths } = options;
        const metadata = new Map(
            (declaration?.artifacts ?? []).map((artifact) => [artifact.path, artifact])
        );
        if (metadata.size !== (declaration?.artifacts?.length ?? 0)) {
            throw new Error('Declared outcome artifact paths must be unique');
        }
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
                content: await this.content.put(
                    path,
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
}

function uniqueId(prefix: string, value: string, index: number): string {
    const slug = basename(value)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 80);
    return `${prefix}_${slug || 'output'}_${index + 1}`;
}
