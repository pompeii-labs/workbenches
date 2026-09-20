import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';

export function launchDirectory(cwd: string, value: string): string {
    const input = value.trim();
    if (!input) throw new Error('Enter a directory to run in');
    if (input.startsWith('~') && input !== '~' && !input.startsWith('~/')) {
        throw new Error('Use ~/ for a path inside your home directory');
    }
    const expanded =
        input === '~' ? homedir() : input.replace(/^~\//u, `${homedir()}/`);
    return resolve(cwd, expanded);
}

export async function directorySuggestions(
    cwd: string,
    value: string
): Promise<string[]> {
    if (value === '~') return ['~/'];
    if (value === '.' || value === '..') return [`${value}/`];
    const expanded = value.startsWith('~/') ? `${homedir()}/${value.slice(2)}` : value;
    const path = resolve(cwd, expanded || '.');
    const trailingSlash = value.endsWith('/');
    const parent = trailingSlash || !value ? path : dirname(path);
    const prefix = trailingSlash || !value ? '' : basename(path);
    const displayParent = trailingSlash
        ? value
        : value.slice(0, value.lastIndexOf('/') + 1);
    const entries = await readdir(parent, { withFileTypes: true }).catch(() => []);
    const matches = await Promise.all(
        entries
            .filter(
                (entry) =>
                    entry.name.toLowerCase().startsWith(prefix.toLowerCase()) &&
                    (!entry.name.startsWith('.') || prefix.startsWith('.'))
            )
            .map(async (entry) => {
                const candidate = resolve(parent, entry.name);
                const directory =
                    entry.isDirectory() ||
                    (entry.isSymbolicLink() &&
                        (await stat(candidate)
                            .then((details) => details.isDirectory())
                            .catch(() => false)));
                return directory ? `${displayParent}${entry.name}/` : undefined;
            })
    );
    return matches
        .filter((match): match is string => match !== undefined)
        .sort((left, right) => left.localeCompare(right))
        .slice(0, 6);
}

export async function validateLaunchDirectory(
    cwd: string,
    value: string
): Promise<string> {
    const path = launchDirectory(cwd, value);
    const details = await stat(path).catch(() => undefined);
    if (!details?.isDirectory()) throw new Error(`Directory does not exist: ${path}`);
    return path;
}
