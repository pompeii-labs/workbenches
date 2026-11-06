import type { RuntimeProcessHandle } from '../types.js';

/** The session or command named by an attach handle is absent, rather than unreachable. */
export class RuntimeProcessMissingError extends Error {
    readonly code = 'runtime_process_missing';

    constructor(readonly handle: RuntimeProcessHandle) {
        super(
            `The ${handle.runtime} session command does not exist: ${handle.sessionId}/${handle.commandId}`
        );
        this.name = 'RuntimeProcessMissingError';
    }
}
