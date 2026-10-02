/** Quotes one value for a POSIX shell command line. */
export function quote(value: string): string {
    if (value.includes('\0')) {
        throw new Error('Command values must not contain NUL');
    }
    return `'${value.replaceAll("'", `'"'"'`)}'`;
}
