import { basename, extname } from 'node:path';

export function outcomeArtifactName(name: string, mediaType: string): string {
    const safe =
        basename(name.replaceAll('\\', '/'))
            .replace(/[^a-zA-Z0-9._-]+/g, '-')
            .replace(/^\.+/, '') || 'artifact';
    if (extname(safe)) return safe;
    const extension = (
        {
            'image/png': '.png',
            'image/jpeg': '.jpg',
            'image/webp': '.webp',
            'image/gif': '.gif',
            'image/svg+xml': '.svg',
            'application/pdf': '.pdf',
            'text/html': '.html',
            'text/markdown': '.md',
            'text/plain': '.txt',
            'application/json': '.json',
        } as Record<string, string>
    )[mediaType];
    return `${safe}${extension ?? ''}`;
}

export function formatOutcomeBytes(bytes: number): string {
    if (bytes < 1_024) return `${bytes} B`;
    const units = ['KiB', 'MiB', 'GiB'];
    let value = bytes;
    let unit = 'B';
    for (const next of units) {
        value /= 1_024;
        unit = next;
        if (value < 1_024) break;
    }
    return `${value.toFixed(value < 10 ? 1 : 0)} ${unit}`;
}
