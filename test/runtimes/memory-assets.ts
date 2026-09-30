import { gunzipSync } from 'node:zlib';
import tar from 'tar-stream';

export { MemoryAssetSource } from '../../src/runtimes/staging/memory-source.js';

/** Lists the regular files and links in a gzip tar, with file text. */
export async function readArchive(
    bytes: Uint8Array
): Promise<Record<string, string | { link: string }>> {
    const extract = tar.extract();
    const result: Record<string, string | { link: string }> = {};
    extract.on('entry', (header, stream, next) => {
        const chunks: Buffer[] = [];
        stream.on('data', (chunk: Buffer) => chunks.push(chunk));
        stream.on('end', () => {
            result[header.name] =
                header.type === 'symlink'
                    ? { link: header.linkname ?? '' }
                    : Buffer.concat(chunks).toString('utf8');
            next();
        });
    });
    const finished = new Promise<void>((resolve, reject) => {
        extract.on('finish', resolve);
        extract.on('error', reject);
    });
    extract.end(gunzipSync(bytes));
    await finished;
    return result;
}
