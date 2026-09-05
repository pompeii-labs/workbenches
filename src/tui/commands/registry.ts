export type TuiCommandCategory = 'Session' | 'Workbench' | 'Display';

export interface TuiCommand {
    name: string;
    aliases?: string[];
    title: string;
    description: string;
    category: TuiCommandCategory;
    usage?: string;
    enabled?: boolean;
    disabledReason?: string;
    run(argument: string): void | Promise<void>;
}

export interface ParsedTuiCommand {
    command: TuiCommand;
    argument: string;
}

export class TuiCommandRegistry {
    readonly #commands: TuiCommand[];

    constructor(commands: TuiCommand[]) {
        const names = new Set<string>();
        for (const command of commands) {
            const candidates = [command.name, ...(command.aliases ?? [])];
            for (const candidate of candidates) {
                const name = normalizeName(candidate);
                if (!name) throw new Error('TUI command names must not be empty');
                if (names.has(name)) throw new Error(`Duplicate TUI command: ${name}`);
                names.add(name);
            }
        }
        this.#commands = commands.toSorted((left, right) =>
            left.name.localeCompare(right.name)
        );
    }

    list(): TuiCommand[] {
        return [...this.#commands];
    }

    find(query: string): TuiCommand[] {
        const needle = normalizeName(query);
        if (!needle) return this.list();
        return this.#commands
            .map((command) => ({ command, score: score(command, needle) }))
            .filter((candidate) => candidate.score >= 0)
            .toSorted(
                (left, right) =>
                    left.score - right.score ||
                    left.command.name.localeCompare(right.command.name)
            )
            .map((candidate) => candidate.command);
    }

    parse(input: string): ParsedTuiCommand | undefined {
        const value = input.trim();
        if (!value.startsWith('/')) return undefined;
        const [rawName = '', ...argument] = value.slice(1).split(/\s+/u);
        const name = normalizeName(rawName);
        const command = this.#commands.find(
            (candidate) =>
                normalizeName(candidate.name) === name ||
                candidate.aliases?.some((alias) => normalizeName(alias) === name)
        );
        return command ? { command, argument: argument.join(' ') } : undefined;
    }

    exact(input: string): TuiCommand | undefined {
        const value = normalizeName(input.replace(/^\//u, ''));
        return this.#commands.find(
            (command) =>
                normalizeName(command.name) === value ||
                command.aliases?.some((alias) => normalizeName(alias) === value)
        );
    }
}

function normalizeName(value: string): string {
    return value.trim().toLowerCase();
}

function score(command: TuiCommand, needle: string): number {
    const names = [command.name, ...(command.aliases ?? [])].map(normalizeName);
    const exact = names.indexOf(needle);
    if (exact >= 0) return exact;
    const prefix = names.findIndex((name) => name.startsWith(needle));
    if (prefix >= 0) return 10 + prefix;
    const title = command.title.toLowerCase();
    if (title.includes(needle)) return 20 + title.indexOf(needle);
    return -1;
}
