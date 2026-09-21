export interface ErrorEmitter {
    on(event: 'error', listener: (error: Error) => void): unknown;
}

export function exitOnBrokenPipe(
    stream: ErrorEmitter,
    exit: (code: number) => never = process.exit
): void {
    stream.on('error', (error) => {
        if ('code' in error && error.code === 'EPIPE') exit(0);
        throw error;
    });
}
