import { formatOutcomeBytes } from '../presentation.js';

export class WorkspaceSnapshotLimitError extends Error {
    readonly maximumBytes: number;
    readonly actualBytes: number;

    constructor(root: string, maximumBytes: number, actualBytes: number) {
        super(
            `Workspace snapshot exceeds the ${formatOutcomeBytes(maximumBytes)} safety limit: ${root} is ${formatOutcomeBytes(actualBytes)}`
        );
        this.name = 'WorkspaceSnapshotLimitError';
        this.maximumBytes = maximumBytes;
        this.actualBytes = actualBytes;
    }
}
