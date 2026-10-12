/** A wait between polls that ends early when its signal aborts. */
export function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.resolve();
    return new Promise((done) => {
        const finish = () => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', finish);
            done();
        };
        const timer = setTimeout(finish, milliseconds);
        signal?.addEventListener('abort', finish, { once: true });
    });
}
