import type { OutcomeSink } from '../../../outcomes/collection.js';
import type {
    OutcomeChangeset,
    OutcomeWorkspace,
} from '../../../outcomes/contracts.js';
import type { ChangedEntry } from './archive.js';
import type { MemoryAssetSnapshot } from './snapshot.js';

/**
 * The changes one run made to a staged workspace, read from the sandbox and
 * checked, and not yet written to a sink. `bytes` counts the file content that
 * will be written.
 */
export class MemoryOutcomeCapture {
    constructor(
        readonly bytes: number,
        private readonly snapshot: MemoryAssetSnapshot,
        private readonly outcome: {
            changed: Map<string, ChangedEntry>;
            deletions: string[];
            workspace: OutcomeWorkspace;
            maximumBytes: number;
        }
    ) {}

    /** Writes the changed content and review diff to `store` and describes the change. */
    collect(store: OutcomeSink): Promise<OutcomeChangeset | undefined> {
        return this.snapshot.changeset(store, this.outcome);
    }
}
