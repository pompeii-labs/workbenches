import { extname } from 'node:path';

export function inferMediaType(path: string): string {
    const extension = extname(path).toLowerCase();
    return (
        {
            '.css': 'text/css',
            '.csv': 'text/csv',
            '.gif': 'image/gif',
            '.htm': 'text/html',
            '.html': 'text/html',
            '.jpeg': 'image/jpeg',
            '.jpg': 'image/jpeg',
            '.js': 'text/javascript',
            '.json': 'application/json',
            '.md': 'text/markdown',
            '.pdf': 'application/pdf',
            '.png': 'image/png',
            '.svg': 'image/svg+xml',
            '.ts': 'text/typescript',
            '.txt': 'text/plain',
            '.webp': 'image/webp',
            '.xml': 'application/xml',
            '.yaml': 'application/yaml',
            '.yml': 'application/yaml',
        }[extension] ?? 'application/octet-stream'
    );
}
