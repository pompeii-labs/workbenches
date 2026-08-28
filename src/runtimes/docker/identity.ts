export function dockerCredentialVolume(runner: string): string {
    return `workbench-${normalize(runner)}-credentials-v0`;
}

export function dockerLocalImage(name: string, digest: string): string {
    return `workbench-local/${normalize(name)}:${digest.slice(0, 24)}`;
}

function normalize(value: string): string {
    const normalized = value
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, '-')
        .replace(/^[._-]+|[._-]+$/g, '');
    return normalized || 'workbench';
}
