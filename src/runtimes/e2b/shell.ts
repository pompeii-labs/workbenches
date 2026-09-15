export function shellCommand(command: string[]): string {
    if (command.length === 0) throw new Error('Runner command is empty');
    return command.map(quote).join(' ');
}

export function quote(value: string): string {
    if (value.includes('\0')) {
        throw new Error('E2B command values must not contain NUL');
    }
    return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function definedEnvironment(
    environment: Record<string, string | undefined>
): Record<string, string> {
    return Object.fromEntries(
        Object.entries(environment).filter(
            (entry): entry is [string, string] => entry[1] !== undefined
        )
    );
}

export function gitExcludePattern(path: string): string {
    return `/${path.replace(/[\\*?[\] !#]/g, '\\$&')}`;
}
