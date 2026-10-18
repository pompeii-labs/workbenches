/** An event was appended with a sequence its run already has. */
export class DuplicateEventSequenceError extends Error {
    readonly runId: string;
    readonly sequence: number;

    constructor(runId: string, sequence: number, options?: ErrorOptions) {
        super(
            `Duplicate event sequence ${sequence} for Workbench run: ${runId}`,
            options
        );
        this.name = 'DuplicateEventSequenceError';
        this.runId = runId;
        this.sequence = sequence;
    }
}
