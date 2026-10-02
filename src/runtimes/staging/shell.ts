/** Quotes one value for a POSIX shell command line. */
export function quote(value: string): string {
    if (value.includes('\0')) {
        throw new Error('Command values must not contain NUL');
    }
    return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/** Joins a runner command into one quoted shell line. */
export function shellCommand(command: string[]): string {
    if (command.length === 0) throw new Error('Runner command is empty');
    return command.map(quote).join(' ');
}

/** The environment without its unset entries. */
export function definedEnvironment(
    environment: Record<string, string | undefined>
): Record<string, string> {
    return Object.fromEntries(
        Object.entries(environment).filter(
            (entry): entry is [string, string] => entry[1] !== undefined
        )
    );
}

/** A Git exclude pattern that matches exactly `path` from the repository root. */
export function gitExcludePattern(path: string): string {
    return `/${path.replace(/[\\*?[\] !#]/g, '\\$&')}`;
}
