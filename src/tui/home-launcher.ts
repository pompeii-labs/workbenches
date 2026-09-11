import type { CatalogEntry } from '../catalog/index.js';
import type { RegistrySearchResult } from '../registry/index.js';

export type HomeCommandName = 'create' | 'resume' | 'help' | 'quit';

export type HomeLauncherResult =
    | { kind: 'saved'; entry: CatalogEntry }
    | { kind: 'registry'; workbench: RegistrySearchResult }
    | {
          kind: 'command';
          name: HomeCommandName;
          title: string;
          description: string;
      };

export class HomeLauncher {
    constructor(
        private readonly entries: CatalogEntry[],
        private readonly canCreate: boolean
    ) {}

    results(
        query: string,
        registryResults: RegistrySearchResult[] = []
    ): HomeLauncherResult[] {
        const normalized = query.trimStart();
        if (normalized.startsWith('/')) {
            return this.commandResults(normalized.slice(1).trim());
        }
        if (!normalized.trim()) return [];
        return this.workbenchResults(normalized.trim(), registryResults);
    }

    emptyMessage(query: string, registryPending = false): string | undefined {
        const normalized = query.trimStart();
        if (!normalized) return;
        if (normalized.startsWith('/')) return 'Unknown launcher command.';
        if (registryPending) return;
        return 'No saved or published Workbenches match that search.';
    }

    private workbenchResults(
        query: string,
        registryResults: RegistrySearchResult[]
    ): HomeLauncherResult[] {
        const saved = this.entries
            .filter((entry) => matchesTerms(entrySearchText(entry), query))
            .map((entry) => ({
                result: { kind: 'saved' as const, entry },
                score: score(entrySearchText(entry), entry.alias, query) + 10,
            }));
        const remote = registryResults
            .filter(
                (workbench) =>
                    matchesTerms(registrySearchText(workbench), query) &&
                    !this.entries.some((entry) => isSaved(entry, workbench))
            )
            .map((workbench) => ({
                result: { kind: 'registry' as const, workbench },
                score: score(
                    registrySearchText(workbench),
                    `${workbench.reference.publisher}/${workbench.reference.workbench}`,
                    query
                ),
            }));
        return [...saved, ...remote]
            .sort(
                (left, right) =>
                    right.score - left.score ||
                    resultKey(left.result).localeCompare(resultKey(right.result))
            )
            .map(({ result }) => result);
    }

    private commandResults(query: string): HomeLauncherResult[] {
        return [
            ...(this.canCreate
                ? [
                      {
                          kind: 'command' as const,
                          name: 'create' as const,
                          title: '/create',
                          description: 'Create or improve a Workbench',
                      },
                  ]
                : []),
            {
                kind: 'command' as const,
                name: 'resume' as const,
                title: '/resume',
                description: 'Find and continue a previous session',
            },
            {
                kind: 'command' as const,
                name: 'help' as const,
                title: '/help',
                description: 'Show launcher commands',
            },
            {
                kind: 'command' as const,
                name: 'quit' as const,
                title: '/quit',
                description: 'Close Workbench',
            },
        ].filter((command) => command.title.slice(1).includes(query.toLowerCase()));
    }
}

function entrySearchText(entry: CatalogEntry): string {
    return [entry.alias, entry.name, entry.source, entry.selector].join(' ');
}

function registrySearchText(workbench: RegistrySearchResult): string {
    return [
        workbench.reference.publisher,
        workbench.reference.workbench,
        workbench.publisherName,
        workbench.name,
        workbench.summary ?? '',
        workbench.runner,
        workbench.runtime,
        workbench.model,
        workbench.sourceReference,
    ].join(' ');
}

function matchesTerms(value: string, query: string): boolean {
    const candidate = value.toLowerCase();
    const candidateTerms = candidate.split(/[^a-z0-9]+/u).filter(Boolean);
    return query
        .toLowerCase()
        .split(/\s+/u)
        .filter(Boolean)
        .every(
            (term) =>
                candidate.includes(term) ||
                candidateTerms.some(
                    (candidateTerm) =>
                        fuzzyDistance(term, candidateTerm) <= fuzzyThreshold(term)
                )
        );
}

function score(value: string, identity: string, query: string): number {
    const candidate = value.toLowerCase();
    const key = identity.toLowerCase();
    const needle = query.toLowerCase();
    if (key === needle) return 100;
    if (key.startsWith(needle)) return 80;
    if (key.includes(needle)) return 60;
    if (candidate.includes(needle)) return 40;
    return 20 - subsequenceGaps(needle, candidate);
}

function subsequenceGaps(needle: string, candidate: string): number {
    let previous = -1;
    let gaps = 0;
    for (const character of needle) {
        const next = candidate.indexOf(character, previous + 1);
        if (next < 0) return 100;
        if (previous >= 0) gaps += next - previous - 1;
        previous = next;
    }
    return gaps;
}

function fuzzyThreshold(value: string): number {
    if (value.length < 3) return 0;
    if (value.length < 7) return 1;
    return 2;
}

function fuzzyDistance(left: string, right: string): number {
    if (left === right) return 0;
    if (!left || !right) return Math.max(left.length, right.length);
    const rows = Array.from({ length: left.length + 1 }, (_, row) =>
        Array.from({ length: right.length + 1 }, (_, column) =>
            row === 0 ? column : column === 0 ? row : 0
        )
    );
    for (let row = 1; row <= left.length; row += 1) {
        for (let column = 1; column <= right.length; column += 1) {
            const substitution = left[row - 1] === right[column - 1] ? 0 : 1;
            const deletion = (rows[row - 1]?.[column] ?? 0) + 1;
            const insertion = (rows[row]?.[column - 1] ?? 0) + 1;
            const replacement = (rows[row - 1]?.[column - 1] ?? 0) + substitution;
            let distance = Math.min(deletion, insertion, replacement);
            if (
                row > 1 &&
                column > 1 &&
                left[row - 1] === right[column - 2] &&
                left[row - 2] === right[column - 1]
            ) {
                distance = Math.min(distance, (rows[row - 2]?.[column - 2] ?? 0) + 1);
            }
            const currentRow = rows[row];
            if (currentRow) currentRow[column] = distance;
        }
    }
    return rows[left.length]?.[right.length] ?? Math.max(left.length, right.length);
}

function isSaved(entry: CatalogEntry, workbench: RegistrySearchResult): boolean {
    if (
        entry.registry?.publisher === workbench.reference.publisher &&
        entry.registry.workbench === workbench.reference.workbench
    ) {
        return true;
    }
    const [source, selector] = workbench.sourceReference.split('#');
    if (!source || !selector || entry.selector !== selector) return false;
    return entry.source === source || entry.source.endsWith(`/${source}`);
}

function resultKey(result: HomeLauncherResult): string {
    if (result.kind === 'saved') return result.entry.alias;
    if (result.kind === 'registry') {
        return `${result.workbench.reference.publisher}/${result.workbench.reference.workbench}`;
    }
    return result.title;
}
