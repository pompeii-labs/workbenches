import type { OutcomeApplicationState, RunOutcome } from '../outcomes/contracts.js';
import type { RunEvents } from './events.js';
import { RunStore } from './store.js';

export async function publishRunOutcome(
    home: string | undefined,
    events: RunEvents,
    outcome: RunOutcome,
    applicationState: OutcomeApplicationState
): Promise<void> {
    if (home) {
        const runs = new RunStore(home);
        // Embedded engine clients can collect without a dispatcher-owned run record.
        const run = await runs.read(events.runId).catch((error) => {
            if (
                error instanceof Error &&
                error.message === `Workbench run does not exist: ${events.runId}`
            )
                return undefined;
            throw error;
        });
        if (run) await runs.update(events.runId, { outcome_id: outcome.id });
    }
    await events.emit('outcome.available', {
        outcome_id: outcome.id,
        completeness: outcome.completeness,
        ...(outcome.turn_index ? { turn_index: outcome.turn_index } : {}),
        application_state: applicationState,
        changesets: outcome.changesets.length,
        artifacts: outcome.artifacts.length,
        links: outcome.links.length,
        warnings: outcome.warnings.length,
        ...(outcome.summary ? { summary: outcome.summary } : {}),
    });
}
