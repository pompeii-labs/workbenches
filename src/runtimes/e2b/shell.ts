import { quote } from '../staging/shell.js';

export function shellCommand(command: string[]): string {
    if (command.length === 0) throw new Error('Runner command is empty');
    return command.map(quote).join(' ');
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
