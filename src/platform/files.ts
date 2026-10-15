import { rename as nativeRename } from 'node:fs/promises';

const retryDelays = [10, 20, 40, 80, 160, 250, 250, 250];
const sharingErrors = new Set(['EPERM', 'EACCES', 'EBUSY']);

/** Readers and virus scanners can briefly prevent atomic replacement on Windows. */
export async function retryWindowsFileOperation<T>(
    operation: () => Promise<T>,
    platform = process.platform
): Promise<T> {
    for (let attempt = 0; ; attempt++) {
        try {
            return await operation();
        } catch (error) {
            const delay = retryDelays[attempt];
            if (
                platform !== 'win32' ||
                delay === undefined ||
                !sharingErrors.has((error as NodeJS.ErrnoException)?.code ?? '')
            )
                throw error;
            await new Promise((resolve) => setTimeout(resolve, delay));
        }
    }
}

/** Keep replacement atomic: never delete the destination to work around a lock. */
export const rename: typeof nativeRename = (from, to) =>
    retryWindowsFileOperation(() => nativeRename(from, to));
