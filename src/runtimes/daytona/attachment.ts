import type { RuntimeProcessHandle } from '../../types.js';
import { RuntimeError } from '../error.js';
import type { RemoteOutput } from '../remote/process.js';
import type { DaytonaSandbox } from './contracts.js';

/** Opens the toolbox command named by a saved handle without launching a command. */
export class SessionAttachment {
    constructor(
        private readonly sandbox: DaytonaSandbox,
        private readonly handle: RuntimeProcessHandle
    ) {}

    start(output: RemoteOutput) {
        if (!this.sandbox.attachSession)
            throw new RuntimeError(
                'daytona',
                'launch',
                'This Daytona sandbox client does not support session attachment'
            );
        return this.sandbox.attachSession(this.handle, { ...output, stdin: true });
    }
}
