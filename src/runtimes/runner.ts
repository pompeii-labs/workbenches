import type { RuntimePrepareRequest } from './contracts.js';

/**
 * The runner CLI a prepared runtime checks for. A request without a runner
 * contract, such as an image build, falls back to the runner's name.
 */
export function runnerExecutable(request: RuntimePrepareRequest): string {
    return request.runner?.executable ?? request.workbench.manifest.runner;
}
