/**
 * Checks a path inside a runner credential store: lowercase relative segments
 * that cannot climb out of the store or carry shell syntax. Returns its segments.
 */
export function credentialPathSegments(path: string): string[] {
    if (!/^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*$/.test(path)) {
        throw new Error(`Invalid credential path: ${path}`);
    }
    return path.split('/');
}
