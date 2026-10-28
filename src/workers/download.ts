type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** The largest package archive the worker accepts. */
const WORKER_DOWNLOAD_LIMIT_BYTES = 64 * 1024 * 1024;

/**
 * The fetch a worker downloads run packages with. The server names each
 * package by a signed URL; the worker follows it only on the API origin,
 * never through a redirect, and reads no more than the size limit.
 */
export class WorkerDownloads {
    readonly #origin: string;

    constructor(
        apiUrl: string,
        private readonly limit = WORKER_DOWNLOAD_LIMIT_BYTES,
        private readonly fetcher: Fetch = fetch
    ) {
        this.#origin = new URL(apiUrl).origin;
    }

    readonly fetch: Fetch = async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : input.toString());
        if (url.origin !== this.#origin)
            throw new Error(`The package URL is not on ${this.#origin}: ${url.origin}`);
        const response = await this.fetcher(url, { ...init, redirect: 'manual' });
        if (response.status >= 300 && response.status < 400)
            throw new Error(
                'The package URL redirects, which the worker does not follow'
            );
        const declared = Number(response.headers.get('content-length') ?? '0');
        if (declared > this.limit) throw this.#tooLarge();
        if (!response.body) return response;
        const chunks: Uint8Array[] = [];
        let size = 0;
        for await (const chunk of response.body) {
            size += chunk.byteLength;
            // Throwing ends the iteration, which cancels the body.
            if (size > this.limit) throw this.#tooLarge();
            chunks.push(chunk);
        }
        return new Response(Buffer.concat(chunks), {
            status: response.status,
            statusText: response.statusText,
            headers: {
                'content-type':
                    response.headers.get('content-type') ?? 'application/json',
            },
        });
    };

    #tooLarge(): Error {
        return new Error(
            `The package is larger than the ${Math.round(this.limit / 1024 / 1024)} MiB the worker accepts`
        );
    }
}
