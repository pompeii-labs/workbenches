import { afterEach, describe, expect, test } from 'bun:test';

import { WorkerDownloads } from '../../src/workers/download.js';

const servers: Array<ReturnType<typeof Bun.serve>> = [];

afterEach(() => {
    for (const server of servers.splice(0)) server.stop(true);
});

function serve(fetch: (request: Request) => Response): string {
    const server = Bun.serve({ port: 0, fetch });
    servers.push(server);
    return `http://127.0.0.1:${server.port}`;
}

describe('worker downloads', () => {
    test('reads a package on the API origin', async () => {
        const api = serve(() => Response.json({ files: [] }));
        const downloads = new WorkerDownloads(api);
        const response = await downloads.fetch(`${api}/v1/packages/signed?sig=x`);
        expect(await response.json()).toEqual({ files: [] });
    });

    test('refuses a URL on another origin before requesting it', async () => {
        let requested = false;
        const other = serve(() => {
            requested = true;
            return Response.json({});
        });
        const downloads = new WorkerDownloads('https://api.workbenches.dev');
        await expect(downloads.fetch(`${other}/package`)).rejects.toThrow(
            'The package URL is not on https://api.workbenches.dev'
        );
        expect(requested).toBe(false);
    });

    test('never follows a redirect off the API origin', async () => {
        let followed = false;
        const elsewhere = serve(() => {
            followed = true;
            return Response.json({});
        });
        const api = serve(() => Response.redirect(`${elsewhere}/package`, 302));
        await expect(new WorkerDownloads(api).fetch(`${api}/package`)).rejects.toThrow(
            'redirects'
        );
        expect(followed).toBe(false);
    });

    test('stops reading a package larger than the limit', async () => {
        const api = serve(
            () =>
                new Response(
                    new ReadableStream({
                        pull(controller) {
                            controller.enqueue(new Uint8Array(1024));
                        },
                    })
                )
        );
        await expect(
            new WorkerDownloads(api, 64 * 1024).fetch(`${api}/package`)
        ).rejects.toThrow('larger than');
    });
});
