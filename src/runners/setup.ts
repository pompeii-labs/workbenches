import type { ResolvedWorkbench } from '../types.js';

export function runnerSetupError(error: unknown, workbench: ResolvedWorkbench): Error {
    const message = error instanceof Error ? error.message : String(error);
    if (
        workbench.manifest.runner !== 'pi' ||
        !message.includes('Runner CLI is unavailable')
    ) {
        return error instanceof Error ? error : new Error(message);
    }
    if (workbench.manifest.runtime === 'local') {
        return new Error(
            'Pi is required for this Workbench but is not installed. Install it with: npm install -g @earendil-works/pi-coding-agent',
            { cause: error }
        );
    }
    return new Error(
        'Pi is required for this Workbench but is not installed in its runtime image. Add @earendil-works/pi-coding-agent to the image and rebuild it.',
        { cause: error }
    );
}
