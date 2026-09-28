export async function withTimeout<T>(
    promise: Promise<T>,
    message: string,
    timeoutMs: number
): Promise<T> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<T>((_, reject) => {
                timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
            }),
        ]);
    } finally {
        if (timeout) clearTimeout(timeout);
    }
}

export function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((accepted, rejected) => {
        resolve = accepted;
        reject = rejected;
    });
    return { promise, resolve, reject };
}
