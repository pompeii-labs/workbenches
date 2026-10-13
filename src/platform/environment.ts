/** Windows environment names are case-insensitive; the last binding wins. */
export function hostEnvironment(
    ...sources: Array<Record<string, string | undefined>>
): Record<string, string | undefined> {
    const result: Record<string, string | undefined> = {};
    for (const source of sources) {
        for (const [name, value] of Object.entries(source)) {
            result[process.platform === 'win32' ? name.toUpperCase() : name] = value;
        }
    }
    return result;
}

/** Supply only the operating-system variables a native Windows process needs. */
export function launchEnvironment(
    environment: Record<string, string | undefined>
): Record<string, string | undefined> {
    const result = hostEnvironment(environment);
    if (process.platform === 'win32') {
        for (const name of [
            'SYSTEMROOT',
            'WINDIR',
            'COMSPEC',
            'PATHEXT',
            'TEMP',
            'TMP',
        ]) {
            if (result[name] === undefined && process.env[name] !== undefined)
                result[name] = process.env[name];
        }
    }
    return result;
}
