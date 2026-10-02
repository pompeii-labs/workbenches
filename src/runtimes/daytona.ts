import type { PreparedRuntime, RuntimeProvider } from './contracts.js';
import { RuntimeError } from './error.js';

/**
 * Reserved provider name. Manifests can declare the daytona runtime and
 * `wb view` reports it, but this engine cannot prepare it yet.
 */
export class DaytonaRuntimeProvider implements RuntimeProvider {
    readonly name = 'daytona';
    readonly placement = 'sandbox' as const;

    async prepare(): Promise<PreparedRuntime> {
        throw new RuntimeError(
            this.name,
            'prepare',
            'The daytona runtime is not available in this engine yet'
        );
    }
}
